import { describe, expect, it } from "vitest";
import { JobRunner } from "../../src/adapters/jobs/job-runner.js";
import { who } from "../support/harness.js";
import { pendingDeposit, setupSaga } from "../support/saga.js";
import { requestWithdrawal } from "../../src/usecases/withdrawals.js";

const DAY = 86_400_000;

describe("JobRunner", () => {
  it("runs every job once per pass", async () => {
    const saga = await setupSaga();
    await pendingDeposit(saga);
    saga.clock.advanceMs(61_000);
    expect(await new JobRunner({ deps: saga.deps, pollMs: 10 }).runOnce()).toEqual({ deposits: 1, debits: 0, payouts: 0 });
  });

  it("loops until stopped, settles due work, and stops quickly even in the middle of a wait", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider.pay(deposit.providerSessionId as string);
    saga.clock.advanceMs(61_000);
    const runner = new JobRunner({ deps: saga.deps, pollMs: 5, batchSize: 1 });
    runner.start();
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await runner.stop();
    expect(saga.deposits()[0]?.status).toBe("succeeded");
    // Stopped: nothing runs any more.
    saga.trading.answerNext({ kind: "unknown", reason: "timeout" });
    await requestWithdrawal(saga.deps, who(), { idempotencyKey: "k", amount: 100 });
    saga.clock.advanceMs(3000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(saga.withdrawals()[0]?.status).toBe("requested");
  });

  it("logs a failed pass and backs off instead of stopping", async () => {
    const saga = await setupSaga();
    const broken = { ...saga.deps, store: Object.create(saga.store, { repositories: { get: () => { throw new Error("database down"); } } }) };
    const runner = new JobRunner({ deps: broken, pollMs: 5, maxBackoffMs: 20 });
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await runner.stop();
    expect(saga.logger.lines.filter((line) => line.level === "error").length).toBeGreaterThanOrEqual(2);
  });

  it("deletes old event ids at most once an hour and keeps the recent ones", async () => {
    const saga = await setupSaga();
    await saga.store.transaction(async (repos) => {
      await repos.inbox.markProcessed("c", { id: "old", type: "t" }, new Date(saga.clock.now().getTime() - 40 * DAY));
      await repos.inbox.markProcessed("c", { id: "new", type: "t" }, new Date(saga.clock.now().getTime() - 1 * DAY));
      await repos.providerEvents.markReceived({ id: "evt_old", type: "t", objectId: "o" }, new Date(saga.clock.now().getTime() - 40 * DAY));
    });
    const runner = new JobRunner({ deps: saga.deps, pollMs: 10 });
    expect(await runner.purgeIfDue()).toBe(2);
    expect(saga.inbox().map((row) => row.id)).toEqual(["new"]);
    expect(saga.providerEvents()).toEqual([]);
    expect(await runner.purgeIfDue()).toBe(0);
    saga.clock.advanceMs(2 * 3_600_000);
    expect(await runner.purgeIfDue()).toBe(0);
  });

  it("logs a purge that fails and keeps running", async () => {
    const saga = await setupSaga();
    const broken = { ...saga.deps, store: Object.create(saga.store, { repositories: { get: () => ({ tenants: { list: () => Promise.resolve([]) }, inbox: { purgeProcessed: () => Promise.reject(new Error("purge failed")) } }) } }) };
    const runner = new JobRunner({ deps: broken, pollMs: 5 });
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await runner.stop();
    expect(saga.logger.lines.some((line) => line.level === "warn")).toBe(true);
  });
});
