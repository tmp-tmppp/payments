import { describe, expect, it } from "vitest";
import { MemoryEventPublisher } from "../../src/adapters/memory/memory-publisher.js";
import { OutboxRelay } from "../../src/adapters/outbox/relay.js";
import { PUBLISHED_RETENTION_MS } from "../../src/adapters/retention.js";
import { depositSucceededEvent } from "../../src/domain/events.js";
import { outboxMessage } from "../../src/usecases/support.js";
import { TENANT_A, createCore } from "../support/harness.js";

type Core = ReturnType<typeof createCore>;

/** Writes the event DepositSucceeded of a deposit of `amount` credits into the outbox, as a use case does. */
async function writeEvent(core: Core, amount: number): Promise<void> {
  core.clock.tick();
  const now = core.clock.now();
  const depositId = core.ids.newId();
  const event = depositSucceededEvent(
    { id: depositId, tenantId: TENANT_A, userId: "user-1", amount },
    now,
    { eventId: core.ids.newId(), now, correlationId: `corr-${amount}`, causationId: `req-${amount}` },
  );
  await core.store.transaction((repositories) => repositories.outbox.add(outboxMessage("DepositSucceeded", event, depositId, now)));
}

async function coreWithEvents(count: number) {
  const core = createCore();
  for (let i = 1; i <= count; i += 1) await writeEvent(core, i);
  const publisher = new MemoryEventPublisher();
  const relay = new OutboxRelay({ store: core.store, publisher, clock: core.clock, logger: core.logger, pollMs: 5, maxBackoffMs: 20 });
  return { ...core, publisher, relay };
}

const amountsOf = (store: { snapshot(): { outbox: Array<{ payload: { data: unknown } }> } }) =>
  store.snapshot().outbox.map((row) => (row.payload.data as { amount: number }).amount);

describe("OutboxRelay", () => {
  it("publishes rows in order, with the event id as message id, and marks them published", async () => {
    const { relay, publisher, store } = await coreWithEvents(3);

    const result = await relay.runOnce();

    expect(result).toEqual({ published: 3, failed: false });
    expect(publisher.published.map((m) => m.event.data)).toEqual([
      expect.objectContaining({ amount: 1 }),
      expect.objectContaining({ amount: 2 }),
      expect.objectContaining({ amount: 3 }),
    ]);
    for (const message of publisher.published) {
      expect(message.messageId).toBe(message.event.id);
      expect(message.subject).toBe(`chance.payments.DepositSucceeded.${message.event.tenantid}`);
    }
    expect(store.snapshot().outbox.every((row) => row.publishedAt !== null)).toBe(true);
  });

  it("publishes a row only once", async () => {
    const { relay, publisher } = await coreWithEvents(2);
    await relay.runOnce();
    expect(await relay.runOnce()).toEqual({ published: 0, failed: false });
    expect(publisher.published).toHaveLength(2);
  });

  it("stops the batch at a failed publish, records the attempt and retries later in the same order", async () => {
    const { relay, publisher, store } = await coreWithEvents(3);
    publisher.failNext = 1;

    const first = await relay.runOnce();

    expect(first).toEqual({ published: 0, failed: true });
    const rows = store.snapshot().outbox;
    expect(rows[0]).toMatchObject({ attempts: 1, publishedAt: null, lastError: "The in-memory publisher was told to fail" });
    expect(rows[1]).toMatchObject({ attempts: 0, publishedAt: null });

    const second = await relay.runOnce();

    expect(second).toEqual({ published: 3, failed: false });
    expect(publisher.published.map((m) => (m.event.data as { amount: number }).amount)).toEqual([1, 2, 3]);
  });

  it("keeps the already published rows when a later one fails", async () => {
    const { relay, publisher, store } = await coreWithEvents(3);
    const publish = publisher.publish.bind(publisher);
    let calls = 0;
    publisher.publish = (...args) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("broker down"));
      return publish(...args);
    };

    expect(await relay.runOnce()).toEqual({ published: 1, failed: true });
    const rows = store.snapshot().outbox;
    expect(rows.map((r) => r.publishedAt !== null)).toEqual([true, false, false]);
    expect(rows[1]).toMatchObject({ attempts: 1, lastError: "broker down" });
  });

  it("claims at most one batch per poll", async () => {
    const core = await coreWithEvents(5);
    const relay = new OutboxRelay({ store: core.store, publisher: core.publisher, clock: core.clock, logger: core.logger, pollMs: 5, batchSize: 2 });
    expect(await relay.runOnce()).toEqual({ published: 2, failed: false });
    expect(core.publisher.published).toHaveLength(2);
  });

  it("polls in the background, recovers from a failure and stops cleanly", async () => {
    const core = await coreWithEvents(2);
    const { relay, publisher, store } = core;
    publisher.failNext = 2;

    relay.start();
    relay.start(); // a second start changes nothing
    await waitFor(() => publisher.published.length === 2);
    await relay.stop();
    expect(store.snapshot().outbox.every((row) => row.publishedAt !== null)).toBe(true);

    // Stopped: an event written now stays in the outbox.
    await writeEvent(core, 9);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(publisher.published).toHaveLength(2);
    expect(store.snapshot().outbox.filter((row) => row.publishedAt === null)).toHaveLength(1);
  });

  it("keeps running when the outbox cannot be read", async () => {
    const { relay, store, logger } = await coreWithEvents(1);
    let failures = 2;
    const transaction = store.transaction.bind(store);
    store.transaction = ((work: Parameters<typeof transaction>[0]) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("database is down"));
      }
      return transaction(work);
    }) as typeof store.transaction;

    relay.start();
    await waitFor(() => store.snapshot().outbox.every((row) => row.publishedAt !== null));
    await relay.stop();

    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(2);
  });
});

describe("OutboxRelay purging", () => {
  const DAY_MS = 24 * 3_600_000;

  it("keeps published rows for 30 days by default, the default max age of the stream, and deletes them after that", async () => {
    const { relay, store, clock } = await coreWithEvents(1);
    expect(PUBLISHED_RETENTION_MS).toBe(30 * DAY_MS);
    await relay.runOnce();

    clock.advanceMs(30 * DAY_MS);
    expect(await relay.purgeIfDue()).toBe(0);
    expect(amountsOf(store)).toEqual([1]);

    clock.advanceMs(3_600_000 + 1); // an hour later, and the row is now older than 30 days
    expect(await relay.purgeIfDue()).toBe(1);
    expect(amountsOf(store)).toEqual([]);
  });

  it("deletes only rows published more than 30 days ago, never an unpublished one however old", async () => {
    const core = await coreWithEvents(2);
    const { relay, store, clock } = core;
    await relay.runOnce(); // amounts 1 and 2, published on day 0
    clock.advanceMs(5 * DAY_MS);
    await writeEvent(core, 3);
    await relay.runOnce(); // published on day 5
    await writeEvent(core, 4); // written on day 5, the relay does not run again
    clock.advanceMs(26 * DAY_MS); // day 31

    expect(await relay.purgeIfDue()).toBe(2);
    expect(amountsOf(store)).toEqual([3, 4]);

    clock.advanceMs(30 * DAY_MS);
    expect(await relay.purgeIfDue()).toBe(1);
    expect(amountsOf(store)).toEqual([4]);
    expect(store.snapshot().outbox[0]).toMatchObject({ publishedAt: null });
  });

  it("deletes at most once an hour, and the first call always runs", async () => {
    const core = await coreWithEvents(1);
    const relay = new OutboxRelay({ store: core.store, publisher: core.publisher, clock: core.clock, logger: core.logger, pollMs: 5, retentionMs: 1000 });
    await relay.runOnce();
    core.clock.advanceMs(5000);

    expect(await relay.purgeIfDue()).toBe(1);

    await writeEvent(core, 2);
    await relay.runOnce();
    core.clock.advanceMs(5000);
    expect(await relay.purgeIfDue()).toBe(0); // the row is old enough, but the last purge was 5 seconds ago
    expect(amountsOf(core.store)).toEqual([2]);
    core.clock.advanceMs(3_600_000 - 5000);
    expect(await relay.purgeIfDue()).toBe(1);
    expect(amountsOf(core.store)).toEqual([]);
  });

  it("is done by the polling loop, and a failing purge neither stops the loop nor loses events", async () => {
    const core = await coreWithEvents(1);
    const { relay, store, clock, publisher, logger } = core;
    await relay.runOnce();
    clock.advanceMs(31 * DAY_MS); // older than the default 30 days
    const purge = store.repositories.outbox.purgePublished.bind(store.repositories.outbox);
    let failures = 1;
    store.repositories.outbox.purgePublished = (olderThan) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("database is down"));
      }
      return purge(olderThan);
    };

    relay.start();
    await waitFor(() => logger.lines.some((line) => line.level === "warn" && String(line.message).includes("could not delete")));
    await writeEvent(core, 2);
    await waitFor(() => publisher.published.length === 2);
    clock.advanceMs(3_600_000 + 1);
    await waitFor(() => !amountsOf(store).includes(1));
    await relay.stop();

    expect(amountsOf(store)).toEqual([2]);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
