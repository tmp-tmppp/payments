import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { JetStreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakePaymentProvider } from "../../src/adapters/memory/fake-provider.js";
import { FakeTrading } from "../../src/adapters/memory/fake-trading.js";
import { NatsEventConsumer } from "../../src/adapters/nats/nats-event-consumer.js";
import { NatsEventPublisher } from "../../src/adapters/nats/nats-event-publisher.js";
import { OutboxRelay } from "../../src/adapters/outbox/relay.js";
import { runMigrations, tenantSchemaName } from "../../src/adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "../../src/adapters/postgres/postgres-store.js";
import { randomIds, systemClock } from "../../src/adapters/system.js";
import { CONSUMED_EVENTS } from "../../src/domain/events.js";
import { TENANT_CREATED_CONSUMER, WITHDRAWAL_REFUNDED_CONSUMER, tenantCreatedHandler, withdrawalRefundedHandler } from "../../src/usecases/consumers.js";
import { createDeposit, getDeposit } from "../../src/usecases/deposits.js";
import { sendPayouts } from "../../src/usecases/jobs.js";
import type { PaymentProvider, PaymentsDeps } from "../../src/usecases/ports.js";
import { handleProviderEvent } from "../../src/usecases/provider-events.js";
import { getWithdrawal, requestWithdrawal } from "../../src/usecases/withdrawals.js";
import { CHECKOUT, RecordingLogger, TestSettings, who } from "../support/harness.js";

// Needs a running Docker daemon: "npm run test:integration". PostgreSQL 18 and NATS with JetStream run in containers; the
// service's own adapters (store, consumers, publisher, relay) run against them. The provider and trading are the fakes.

const NATS_IMAGE = "nats:2.15.2-alpine";
const TENANT_1 = "018f3c1e-7a00-7000-8000-0000000000a1";
const TENANT_2 = "018f3c1e-7a00-7000-8000-0000000000a2";

let postgres: StartedPostgreSqlContainer;
let broker: StartedTestContainer;
let pool: pg.Pool;
let store: PostgresStore;
let natsUrl: string;
let admin: NatsConnection;
let manager: JetStreamManager;
const logger = new RecordingLogger();
const settings = new TestSettings();
const provider = new FakePaymentProvider();
const trading = new FakeTrading();
const deps = (): PaymentsDeps => ({ store, clock: systemClock, ids: randomIds, logger, provider, trading, settings, checkout: CHECKOUT });

beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:18").withDatabase("payments").start();
  pool = createPool(postgres.getConnectionUri(), 8);
  store = new PostgresStore(pool, logger);
  await runMigrations(pool, logger);
  broker = await new GenericContainer(NATS_IMAGE).withCommand(["--jetstream"]).withExposedPorts(4222).withWaitStrategy(Wait.forLogMessage(/Server is ready/)).start();
  natsUrl = `nats://${broker.getHost()}:${broker.getMappedPort(4222)}`;
  admin = await connect({ servers: natsUrl });
  manager = await jetstreamManager(admin);
}, 240_000);

afterAll(async () => {
  await admin?.drain();
  await pool?.end();
  await broker?.stop();
  await postgres?.stop();
});

async function eventually<T>(read: () => Promise<T | null | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A CloudEvent as another service publishes it. */
function cloudEvent(id: string, type: string, subject: string, tenantId: string, data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ specversion: "1.0", id, type, source: "test", subject, time: new Date().toISOString(), datacontenttype: "application/json", tenantid: tenantId, correlationid: "corr", causationid: "cause", data }),
  );
}

const schemaExists = async (tenantId: string): Promise<boolean> =>
  ((await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [tenantSchemaName(tenantId)])).rowCount ?? 0) > 0;

describe("NATS consumers over PostgreSQL", () => {
  it("TenantCreated creates the tenant's schema once; a second message with the same event id changes nothing", async () => {
    await manager.streams.add({ name: "TENANTS", subjects: ["chance.tenants.>"] });
    const publish = async (id: string, tenantId: string): Promise<void> => {
      await jetstream(admin).publish(`${CONSUMED_EVENTS.tenantCreated.subjectPrefix}.${tenantId}`, cloudEvent(id, CONSUMED_EVENTS.tenantCreated.type, `tenant/${tenantId}`, tenantId, { tenantId, name: "Acme" }));
    };
    await publish("evt-tenant-1", TENANT_1);
    await publish("evt-tenant-1", TENANT_1);
    await publish("evt-tenant-2", TENANT_2);
    const consumer = new NatsEventConsumer(
      natsUrl,
      logger,
      [{ stream: "TENANTS", durable: TENANT_CREATED_CONSUMER, filterSubject: `${CONSUMED_EVENTS.tenantCreated.subjectPrefix}.*`, handler: tenantCreatedHandler(deps()) }],
      { retryMs: 200, maxRetryMs: 500 },
    );
    consumer.start();
    try {
      await eventually(async () => (await store.repositories.tenants.exists(TENANT_2)) && (await store.repositories.tenants.exists(TENANT_1)), "both tenant schemas");
      expect(await schemaExists(TENANT_1)).toBe(true);
      expect(await schemaExists(TENANT_2)).toBe(true);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM shared.inbox WHERE consumer = $1 AND event_id = $2", [TENANT_CREATED_CONSUMER, "evt-tenant-1"]);
      expect(rows[0]?.n).toBe(1);
    } finally {
      await consumer.stop();
    }
  });

  it("starts while the TRADING stream is missing, retries with a log line, and refunds a failed withdrawal once the stream and the event exist", async () => {
    // A failed withdrawal: debited, then the payout is declined by the force flag (reason "forced").
    settings.force = true;
    const { withdrawal } = await requestWithdrawal(deps(), who("trader-1", TENANT_1, 1), { idempotencyKey: "broker-w-1", amount: 700 });
    expect(withdrawal.status).toBe("debited");
    await sendPayouts(deps(), 10);
    expect((await getWithdrawal(deps(), who("trader-1", TENANT_1, 2), withdrawal.id)).status).toBe("failed");

    const consumer = new NatsEventConsumer(
      natsUrl,
      logger,
      [{ stream: "TRADING", durable: WITHDRAWAL_REFUNDED_CONSUMER, filterSubject: `${CONSUMED_EVENTS.withdrawalRefunded.subjectPrefix}.*`, handler: withdrawalRefundedHandler(deps()) }],
      { retryMs: 200, maxRetryMs: 500 },
    );
    consumer.start();
    try {
      await eventually(() => Promise.resolve(logger.lines.some((line) => line.message === "The stream of a consumer does not exist yet; trying again")), "the missing-stream warning");
      await manager.streams.add({ name: "TRADING", subjects: ["chance.trading.>"] });
      await jetstream(admin).publish(
        `${CONSUMED_EVENTS.withdrawalRefunded.subjectPrefix}.${TENANT_1}`,
        cloudEvent("evt-refund-1", CONSUMED_EVENTS.withdrawalRefunded.type, `withdrawal/${withdrawal.id}`, TENANT_1, { withdrawalId: withdrawal.id, userId: "trader-1", amount: 700 }),
      );
      const refunded = await eventually(async () => {
        const current = await getWithdrawal(deps(), who("trader-1", TENANT_1, 3), withdrawal.id);
        return current.status === "refunded" ? current : null;
      }, "the withdrawal to be refunded");
      expect(refunded.status).toBe("refunded");
    } finally {
      await consumer.stop();
      settings.force = false;
    }
  });

  it("goes on consuming after the TRADING stream was deleted and created again while the service runs", async () => {
    settings.force = true;
    const { withdrawal } = await requestWithdrawal(deps(), who("trader-1", TENANT_1, 20), { idempotencyKey: "broker-w-2", amount: 300 });
    await sendPayouts(deps(), 10);
    expect((await getWithdrawal(deps(), who("trader-1", TENANT_1, 21), withdrawal.id)).status).toBe("failed");

    const consumer = new NatsEventConsumer(
      natsUrl,
      logger,
      [{ stream: "TRADING", durable: WITHDRAWAL_REFUNDED_CONSUMER, filterSubject: `${CONSUMED_EVENTS.withdrawalRefunded.subjectPrefix}.*`, handler: withdrawalRefundedHandler(deps()) }],
      { retryMs: 200, maxRetryMs: 500 },
    );
    const consuming = (): number => logger.lines.filter((line) => line.message === "Consuming events").length;
    const startedBefore = consuming();
    consumer.start();
    try {
      await eventually(() => Promise.resolve(consuming() > startedBefore), "this consumer to start consuming");
      const warnings = (): number => logger.lines.filter((line) => line.level === "warn").length;
      const before = warnings();
      await manager.streams.delete("TRADING");
      await eventually(() => Promise.resolve(warnings() > before), "the consumer to notice that its stream is gone", 60_000);
      await manager.streams.add({ name: "TRADING", subjects: ["chance.trading.>"] });
      await jetstream(admin).publish(
        `${CONSUMED_EVENTS.withdrawalRefunded.subjectPrefix}.${TENANT_1}`,
        cloudEvent("evt-refund-2", CONSUMED_EVENTS.withdrawalRefunded.type, `withdrawal/${withdrawal.id}`, TENANT_1, { withdrawalId: withdrawal.id, userId: "trader-1", amount: 300 }),
      );
      const refunded = await eventually(async () => {
        const current = await getWithdrawal(deps(), who("trader-1", TENANT_1, 22), withdrawal.id);
        return current.status === "refunded" ? current : null;
      }, "the withdrawal to be refunded after the stream came back", 60_000);
      expect(refunded.status).toBe("refunded");
    } finally {
      await consumer.stop();
      settings.force = false;
    }
  }, 240_000);
});

describe("the outbox relay over NATS", () => {
  it("publishes DepositSucceeded to the PAYMENTS stream with the subject and type of the contract, once", async () => {
    const created = await createDeposit(deps(), who("trader-2", TENANT_1, 10), { idempotencyKey: "broker-d-1", amount: 2500 });
    const sessionId = created.deposit.providerSessionId;
    if (sessionId === null) throw new Error("the deposit has no checkout session");
    provider.pay(sessionId);
    const input = { id: "evt_broker_1", type: "checkout.session.completed", objectKind: "checkout_session" as const, objectId: sessionId, correlationId: "corr-broker" };
    expect(await handleProviderEvent(deps(), input)).toBe("processed");
    expect(await handleProviderEvent(deps(), input)).toBe("duplicate");
    expect((await getDeposit(deps(), who("trader-2", TENANT_1, 11), created.deposit.id)).status).toBe("succeeded");

    const publisher = new NatsEventPublisher(natsUrl, logger);
    const relay = new OutboxRelay({ store, publisher, clock: systemClock, logger, pollMs: 50 });
    try {
      const result = await relay.runOnce();
      expect(result).toMatchObject({ failed: false });
      expect(result.published).toBeGreaterThanOrEqual(1);
      const message = await manager.streams.getMessage("PAYMENTS", { last_by_subj: `chance.payments.DepositSucceeded.${TENANT_1}` });
      if (message === null) throw new Error("no DepositSucceeded on the stream");
      const event = message.json<{ type: string; tenantid: string; data: Record<string, unknown> }>();
      expect(event).toMatchObject({ type: "si.chance.payments.DepositSucceeded.v1", tenantid: TENANT_1 });
      expect(event.data).toMatchObject({ depositId: created.deposit.id, userId: "trader-2", amount: 2500 });
      // Nothing is sent twice: a second run finds no unsent row for this deposit.
      const info = await manager.streams.info("PAYMENTS");
      await relay.runOnce();
      expect((await manager.streams.info("PAYMENTS")).state.messages).toBe(info.state.messages);
    } finally {
      await publisher.close();
    }
  });
});

describe("concurrent work over PostgreSQL", () => {
  it("two requests with the same Idempotency-Key make one deposit and one checkout session", async () => {
    const caller = who("trader-3", TENANT_2, 20);
    const [first, second] = await Promise.all([
      createDeposit(deps(), caller, { idempotencyKey: "race-d-1", amount: 900 }),
      createDeposit(deps(), caller, { idempotencyKey: "race-d-1", amount: 900 }),
    ]);
    expect(first.deposit.id).toBe(second.deposit.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(provider.sessionList().filter((session) => session.metadata["depositId"] === first.deposit.id)).toHaveLength(1);
  });

  it("a slow provider holds no database connection: with a pool of 2 and six deposits waiting for it, the readiness ping answers at once", async () => {
    const small = createPool(postgres.getConnectionUri(), 2);
    const smallStore = new PostgresStore(small, logger);
    const slow: PaymentProvider = {
      createCheckoutSession: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return provider.createCheckoutSession(input);
      },
      getCheckoutSession: (id) => provider.getCheckoutSession(id),
      createPayout: (input) => provider.createPayout(input),
      getPayout: (id) => provider.getPayout(id),
    };
    try {
      const slowDeps: PaymentsDeps = { ...deps(), store: smallStore, provider: slow };
      const creating = Array.from({ length: 6 }, (_, n) => createDeposit(slowDeps, who("trader-5", TENANT_2, 50 + n), { idempotencyKey: `slow-${n}`, amount: 100 }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const started = Date.now();
      await smallStore.ping();
      expect(Date.now() - started).toBeLessThan(1000);
      const made = await Promise.all(creating);
      expect(made.every((result) => result.deposit.checkoutUrl !== null)).toBe(true);
    } finally {
      await small.end();
    }
  });

  it("two job runners claim each due payout once (FOR UPDATE SKIP LOCKED): every withdrawal fails once, one WithdrawalFailed event each", async () => {
    settings.force = true;
    try {
      const ids: string[] = [];
      for (let n = 1; n <= 3; n += 1) {
        const { withdrawal } = await requestWithdrawal(deps(), who("trader-4", TENANT_2, 30 + n), { idempotencyKey: `race-w-${n}`, amount: 100 + n });
        ids.push(withdrawal.id);
      }
      const handled = await Promise.all([sendPayouts(deps(), 10), sendPayouts(deps(), 10)]);
      expect(handled[0] + handled[1]).toBeGreaterThanOrEqual(3);
      for (const id of ids) expect((await getWithdrawal(deps(), who("trader-4", TENANT_2, 40), id)).status).toBe("failed");
      const { rows } = await pool.query("SELECT aggregate_id, count(*)::int AS n FROM shared.outbox WHERE type = $1 AND aggregate_id = ANY($2) GROUP BY aggregate_id", [
        "si.chance.payments.WithdrawalFailed.v1",
        ids,
      ]);
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row.n).toBe(1);
    } finally {
      settings.force = false;
    }
  });
});
