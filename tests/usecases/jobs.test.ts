import { describe, expect, it } from "vitest";
import { PaymentProviderRejected, PaymentProviderUnavailable } from "../../src/usecases/errors.js";
import { createDeposit } from "../../src/usecases/deposits.js";
import { PAYOUT_ALERT_ATTEMPTS, checkDeposits, retryDebits, runDueWork, sendPayouts } from "../../src/usecases/jobs.js";
import { requestWithdrawal } from "../../src/usecases/withdrawals.js";
import { TENANT_A, who } from "../support/harness.js";
import { eventErrors } from "../support/contracts.js";
import { debitedWithdrawal, pendingDeposit, setupSaga, withdrawalWithPayout } from "../support/saga.js";

const MINUTE = 60_000;

describe("checkDeposits (reconcile and expire)", () => {
  it("leaves a pending deposit alone while its session is open, and looks again later with a longer wait", async () => {
    const saga = await setupSaga();
    await pendingDeposit(saga);
    expect(await checkDeposits(saga.deps, 10)).toBe(0);
    saga.clock.advanceMs(61_000);
    expect(await checkDeposits(saga.deps, 10)).toBe(1);
    expect(saga.provider.calls).toContain("getCheckoutSession");
    expect(saga.deposits()[0]).toMatchObject({ status: "pending" });
    expect(saga.deposits()[0]).toMatchObject({ checkAttempts: 1 });
    expect(saga.deposits()[0]?.nextCheckAt?.getTime()).toBe(saga.clock.now().getTime() + 2 * MINUTE);
  });

  it("backs the read-backs off (1, 2, 5, 10, then every 20 minutes) instead of asking the provider every minute", async () => {
    const saga = await setupSaga();
    saga.provider.sessionTtlMs = 24 * 60 * MINUTE;
    await pendingDeposit(saga);
    const gaps: number[] = [];
    for (let step = 0; step < 6; step += 1) {
      const before = saga.deposits()[0]?.nextCheckAt?.getTime() ?? 0;
      saga.clock.advanceMs(before - saga.clock.now().getTime());
      await checkDeposits(saga.deps, 10);
      gaps.push(((saga.deposits()[0]?.nextCheckAt?.getTime() ?? 0) - saga.clock.now().getTime()) / MINUTE);
    }
    expect(gaps).toEqual([2, 5, 10, 20, 20, 20]);
  });

  it("completes a deposit whose webhook was lost, as soon as the next look finds the session paid", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider.pay(deposit.providerSessionId as string);
    saga.clock.advanceMs(61_000);
    await checkDeposits(saga.deps, 10);
    expect(saga.deposits()[0]?.status).toBe("succeeded");
    expect(saga.outbox()[0]?.type).toBe("si.chance.payments.DepositSucceeded.v1");
    expect(eventErrors("DepositSucceededEvent", saga.outbox()[0]?.payload)).toEqual([]);
  });

  it("fails a deposit whose session the provider reads as expired after its 30 minutes: reason expired, DepositFailed", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    // The job looks at 1, 3, 8 and 18 minutes and then right after the session's own end at 30 minutes (not at 38).
    for (let minute = 1; minute <= 31; minute += 1) {
      saga.clock.advanceMs(MINUTE);
      await checkDeposits(saga.deps, 10);
      expect(saga.deposits()[0]?.status).toBe(minute < 31 ? "pending" : "failed");
    }
    expect(saga.provider.calls.filter((call) => call === "getCheckoutSession")).toHaveLength(5);
    expect(saga.deposits()[0]).toMatchObject({ status: "failed", failureReason: "expired", id: deposit.id });
    expect(saga.outbox()).toHaveLength(1);
    expect(saga.outbox()[0]?.payload).toMatchObject({ type: "si.chance.payments.DepositFailed.v1", data: { reason: "expired" } });
    expect(eventErrors("DepositFailedEvent", saga.outbox()[0]?.payload)).toEqual([]);
  });

  it("never fails a deposit on payments' own 30 minutes while the provider says the session is open (its lifetime is longer)", async () => {
    const saga = await setupSaga();
    saga.provider.sessionTtlMs = 60 * MINUTE;
    const deposit = await pendingDeposit(saga);
    for (let minute = 1; minute <= 60; minute += 1) {
      saga.clock.advanceMs(MINUTE);
      await checkDeposits(saga.deps, 10);
      expect(saga.deposits()[0]?.status).toBe("pending");
    }
    expect(saga.outbox()).toEqual([]);
    // Paid in the window after payments' 30 minutes: it is a success, not a silent loss.
    saga.provider.pay(deposit.providerSessionId as string);
    saga.clock.advanceMs(25 * MINUTE);
    await checkDeposits(saga.deps, 10);
    expect(saga.deposits()[0]).toMatchObject({ status: "succeeded" });
    expect(saga.outbox()[0]?.type).toBe("si.chance.payments.DepositSucceeded.v1");
  });

  it("lets a completed session win over the 30 minutes: it is read back first", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider.pay(deposit.providerSessionId as string);
    saga.clock.advanceMs(45 * MINUTE);
    await checkDeposits(saga.deps, 10);
    expect(saga.deposits()[0]?.status).toBe("succeeded");
  });

  it("fails a deposit whose session the provider forgot: nobody can pay it any more", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider.restart();
    saga.clock.advanceMs(2 * MINUTE);
    await checkDeposits(saga.deps, 10);
    expect(saga.deposits()[0]).toMatchObject({ id: deposit.id, status: "failed", failureReason: "expired" });
  });

  it("fails a deposit the buyer declined, with the reason declined", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider.decline(deposit.providerSessionId as string);
    saga.clock.advanceMs(2 * MINUTE);
    await checkDeposits(saga.deps, 10);
    expect(saga.deposits()[0]).toMatchObject({ status: "failed", failureReason: "declined" });
  });

  it("keeps the deposit pending when the provider does not answer, counts the try and waits longer each time", async () => {
    const saga = await setupSaga();
    await pendingDeposit(saga);
    saga.clock.advanceMs(61_000);
    saga.provider.failNext(new PaymentProviderUnavailable("down"));
    await checkDeposits(saga.deps, 10);
    expect(saga.deposits()[0]).toMatchObject({ status: "pending", checkAttempts: 1 });
    expect(saga.deposits()[0]?.nextCheckAt?.getTime()).toBe(saga.clock.now().getTime() + 5000);
    saga.clock.advanceMs(6000);
    saga.provider.failNext(new PaymentProviderRejected(503, null, "still down"));
    await checkDeposits(saga.deps, 10);
    expect(saga.deposits()[0]).toMatchObject({ checkAttempts: 2 });
    expect(saga.deposits()[0]?.nextCheckAt?.getTime()).toBe(saga.clock.now().getTime() + 10_000);
  });

  it("creates the checkout session of a deposit whose request could not reach the provider (same key), and attaches it", async () => {
    const saga = await setupSaga();
    saga.provider.failNext(new PaymentProviderUnavailable("down"));
    await expect(createDeposit(saga.deps, who(), { idempotencyKey: "k-down", amount: 700 })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(saga.deposits()[0]).toMatchObject({ status: "pending", providerSessionId: null });
    saga.clock.advanceMs(61_000);
    expect(await checkDeposits(saga.deps, 10)).toBe(1);
    expect(saga.deposits()[0]?.providerSessionId).toBe(saga.provider.sessionList()[0]?.id);
    expect(saga.deposits()[0]?.checkoutUrl).not.toBeNull();
    expect(saga.provider.sessionList()).toHaveLength(1);
  });

  it("fails a deposit that never got a checkout session in 30 minutes with provider_unavailable (the buyer never had a link)", async () => {
    const saga = await setupSaga();
    saga.provider.failNext(...Array.from({ length: 60 }, () => new PaymentProviderUnavailable("down")));
    await expect(createDeposit(saga.deps, who(), { idempotencyKey: "k-down", amount: 700 })).rejects.toMatchObject({ code: "provider_unavailable" });
    for (let minute = 1; minute <= 30; minute += 1) {
      saga.clock.advanceMs(MINUTE);
      await checkDeposits(saga.deps, 10);
      expect(saga.deposits()[0]?.status).toBe(minute < 30 ? "pending" : "failed");
    }
    expect(saga.deposits()[0]).toMatchObject({ status: "failed", failureReason: "provider_unavailable", providerSessionId: null });
    expect(saga.outbox()[0]?.payload).toMatchObject({ type: "si.chance.payments.DepositFailed.v1", data: { reason: "provider_unavailable" } });
    expect(eventErrors("DepositFailedEvent", saga.outbox()[0]?.payload)).toEqual([]);
  });

  it("is not done twice by two replicas working at once", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider.pay(deposit.providerSessionId as string);
    saga.clock.advanceMs(61_000);
    const counts = await Promise.all([checkDeposits(saga.deps, 10), checkDeposits(saga.deps, 10)]);
    expect(counts.sort()).toEqual([0, 1]);
    expect(saga.provider.calls.filter((call) => call === "getCheckoutSession")).toHaveLength(1);
    expect(saga.outbox()).toHaveLength(1);
  });

  it("logs a step that throws and goes on; the row is repeated when its lease ends", async () => {
    const saga = await setupSaga();
    await pendingDeposit(saga);
    saga.clock.advanceMs(61_000);
    saga.provider.failNext(new TypeError("a bug"));
    expect(await checkDeposits(saga.deps, 10)).toBe(1);
    expect(saga.logger.lines.some((line) => line.level === "error")).toBe(true);
    expect(saga.deposits()[0]?.status).toBe("pending");
  });
});

describe("retryDebits", () => {
  it("repeats a debit whose answer was lost with the same withdrawal id, and the credits are taken once", async () => {
    const saga = await setupSaga();
    saga.trading.loseNextAnswers(1);
    const { withdrawal } = await requestWithdrawal(saga.deps, who(), { idempotencyKey: "k", amount: 700 });
    expect(withdrawal.status).toBe("requested");

    expect(await retryDebits(saga.deps, 10)).toBe(0);
    saga.clock.advanceMs(3000);
    expect(await retryDebits(saga.deps, 10)).toBe(1);

    expect(saga.withdrawals()[0]).toMatchObject({ status: "debited", nextDebitAt: null });
    expect(saga.trading.requests.map((request) => request.withdrawalId)).toEqual([withdrawal.id, withdrawal.id]);
    // The repeat carries the job's own correlation id (the request's caller is gone by then).
    expect(saga.trading.requests[1]?.correlationId).toBe(`debit-retry:${withdrawal.id}`);
    expect(saga.trading.creditsOf(TENANT_A, "user-1")).toBe(1_000_000 - 700);
  });

  it("rejects the withdrawal when trading finally answers 409", async () => {
    const saga = await setupSaga();
    saga.trading.answerNext({ kind: "unknown", reason: "timeout" });
    await requestWithdrawal(saga.deps, who(), { idempotencyKey: "k", amount: 700 });
    saga.trading.setCredits(TENANT_A, "user-1", 5);
    saga.clock.advanceMs(3000);
    await retryDebits(saga.deps, 10);
    expect(saga.withdrawals()[0]).toMatchObject({ status: "rejected", reason: "insufficient_credits" });
  });

  it("keeps trying while trading is unreachable, with a longer wait each time, and never rejects for an open circuit", async () => {
    const saga = await setupSaga();
    saga.trading.answerNext({ kind: "unknown", reason: "timeout" }, { kind: "circuit_open" }, { kind: "unknown", reason: "timeout" });
    await requestWithdrawal(saga.deps, who(), { idempotencyKey: "k", amount: 700 });
    const waits: number[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      saga.clock.advanceMs(61_000);
      await retryDebits(saga.deps, 10);
      const row = saga.withdrawals()[0];
      expect(row?.status).toBe("requested");
      waits.push((row?.nextDebitAt?.getTime() ?? 0) - saga.clock.now().getTime());
    }
    expect(waits).toEqual([4000, 8000]);
    saga.clock.advanceMs(61_000);
    await retryDebits(saga.deps, 10);
    expect(saga.withdrawals()[0]?.status).toBe("debited");
  });

  it("does not touch a withdrawal that is not due yet, and is not done twice by two replicas", async () => {
    const saga = await setupSaga();
    saga.trading.answerNext({ kind: "unknown", reason: "timeout" });
    await requestWithdrawal(saga.deps, who(), { idempotencyKey: "k", amount: 700 });
    expect(await retryDebits(saga.deps, 10)).toBe(0);
    saga.clock.advanceMs(3000);
    const counts = await Promise.all([retryDebits(saga.deps, 10), retryDebits(saga.deps, 10)]);
    expect(counts.sort()).toEqual([0, 1]);
    expect(saga.trading.requests).toHaveLength(2);
  });

  it("logs a failing step and goes on", async () => {
    const saga = await setupSaga();
    saga.trading.answerNext({ kind: "unknown", reason: "timeout" });
    await requestWithdrawal(saga.deps, who(), { idempotencyKey: "k", amount: 700 });
    saga.clock.advanceMs(3000);
    const broken = { debit: () => Promise.reject(new Error("boom")) };
    expect(await retryDebits({ ...saga.deps, trading: broken }, 10)).toBe(1);
    expect(saga.logger.lines.some((line) => line.level === "error")).toBe(true);
  });
});

describe("sendPayouts", () => {
  it("creates the payout of a debited withdrawal once, then reads it back until the provider settles it", async () => {
    const saga = await setupSaga();
    const { withdrawal, payout } = await withdrawalWithPayout(saga);
    expect(payout).toMatchObject({ amount: 1800, destination: "user-1", metadata: { tenantId: TENANT_A, withdrawalId: withdrawal.id } });
    expect(saga.withdrawals()[0]).toMatchObject({ status: "debited", providerPayoutId: payout.id });

    saga.clock.advanceMs(11_000);
    expect(await sendPayouts(saga.deps, 10)).toBe(1);
    expect(saga.withdrawals()[0]?.status).toBe("debited");
    expect(saga.provider.calls.filter((call) => call === "createPayout")).toHaveLength(1);

    saga.provider.settlePayouts();
    saga.clock.advanceMs(11_000);
    await sendPayouts(saga.deps, 10);
    expect(saga.withdrawals()[0]?.status).toBe("paid_out");
    expect(saga.outbox()[0]?.payload).toMatchObject({ type: "si.chance.payments.WithdrawalSucceeded.v1" });
    expect(eventErrors("WithdrawalSucceededEvent", saga.outbox()[0]?.payload)).toEqual([]);
  });

  it("fails the withdrawal when the provider's own test mode declines the payout (a second, independent failure path)", async () => {
    const saga = await setupSaga();
    await withdrawalWithPayout(saga);
    saga.provider.declinePayouts = true;
    saga.provider.settlePayouts();
    saga.clock.advanceMs(11_000);
    await sendPayouts(saga.deps, 10);
    expect(saga.withdrawals()[0]).toMatchObject({ status: "failed", reason: "declined" });
    expect(saga.outbox()[0]?.payload).toMatchObject({ type: "si.chance.payments.WithdrawalFailed.v1", data: { reason: "declined" } });
    expect(eventErrors("WithdrawalFailedEvent", saga.outbox()[0]?.payload)).toEqual([]);
  });

  it("declines the payout itself, before calling the provider, while the force-payout-failure flag is on", async () => {
    const saga = await setupSaga();
    saga.settings.force = true;
    const withdrawal = await debitedWithdrawal(saga);
    await sendPayouts(saga.deps, 10);
    expect(saga.provider.calls).toEqual([]);
    expect(saga.withdrawals()[0]).toMatchObject({ id: withdrawal.id, status: "failed", reason: "forced" });
    expect(saga.outbox()[0]?.payload).toMatchObject({ type: "si.chance.payments.WithdrawalFailed.v1", data: { reason: "forced", withdrawalId: withdrawal.id } });
  });

  it("reads the flag at every use: a flip while the service runs counts, and a payout already created is not forced", async () => {
    const saga = await setupSaga();
    const first = await withdrawalWithPayout(saga, 100);
    saga.settings.force = true;
    const second = await debitedWithdrawal(saga, 200, "user-2");
    saga.clock.advanceMs(11_000);
    await sendPayouts(saga.deps, 10);
    const byId = new Map(saga.withdrawals().map((row) => [row.id, row]));
    expect(byId.get(second.id)).toMatchObject({ status: "failed", reason: "forced" });
    expect(byId.get(first.withdrawal.id)?.status).toBe("debited");
    saga.settings.force = false;
    saga.provider.settlePayouts();
    saga.clock.advanceMs(11_000);
    await sendPayouts(saga.deps, 10);
    expect(new Map(saga.withdrawals().map((row) => [row.id, row])).get(first.withdrawal.id)?.status).toBe("paid_out");
  });

  it("treats a payout the provider no longer knows (404) as failed: payout_lost", async () => {
    const saga = await setupSaga();
    await withdrawalWithPayout(saga);
    saga.provider.restart();
    saga.clock.advanceMs(11_000);
    await sendPayouts(saga.deps, 10);
    expect(saga.withdrawals()[0]).toMatchObject({ status: "failed", reason: "payout_lost" });
    expect(saga.outbox()[0]?.payload).toMatchObject({ data: { reason: "payout_lost" } });
  });

  it("keeps the withdrawal debited when the provider is down, and creates the payout when it is back", async () => {
    const saga = await setupSaga();
    await debitedWithdrawal(saga);
    saga.provider.failNext(new PaymentProviderUnavailable("down"));
    await sendPayouts(saga.deps, 10);
    expect(saga.withdrawals()[0]).toMatchObject({ status: "debited", payoutAttempts: 1, providerPayoutId: null });
    expect(saga.withdrawals()[0]?.payoutRequestedAt).not.toBeNull();
    expect(saga.withdrawals()[0]?.nextPayoutAt?.getTime()).toBe(saga.clock.now().getTime() + 5000);
    saga.clock.advanceMs(6000);
    await sendPayouts(saga.deps, 10);
    expect(saga.withdrawals()[0]?.providerPayoutId).not.toBeNull();
  });

  it("fails the withdrawal when the provider refuses the payout for good (a 4xx)", async () => {
    const saga = await setupSaga();
    await debitedWithdrawal(saga);
    saga.provider.failNext(new PaymentProviderRejected(422, "invalid_request", "no"));
    await sendPayouts(saga.deps, 10);
    expect(saga.withdrawals()[0]).toMatchObject({ status: "failed", reason: "declined" });
  });

  it("never gives up creating a payout whose create may have reached the provider: the provider stores it, the answer is lost 65 times, no WithdrawalFailed", async () => {
    const saga = await setupSaga();
    const withdrawal = await debitedWithdrawal(saga);
    const lost = PAYOUT_ALERT_ATTEMPTS + 5;
    saga.provider.loseNextAnswers("createPayout", lost);
    for (let attempt = 1; attempt <= lost; attempt += 1) {
      saga.clock.advanceMs(10 * MINUTE);
      await sendPayouts(saga.deps, 10);
      expect(saga.withdrawals()[0]).toMatchObject({ status: "debited", providerPayoutId: null, payoutAttempts: attempt });
    }
    expect(saga.outbox()).toEqual([]);
    // From the alert count on every try says so in an error line.
    expect(saga.logger.lines.some((line) => line.level === "error" && line.message?.includes("needs a look"))).toBe(true);
    // The answer comes back: the same Idempotency-Key returns the one payout the provider made, and the withdrawal goes on.
    saga.clock.advanceMs(10 * MINUTE);
    await sendPayouts(saga.deps, 10);
    expect(saga.provider.payoutList()).toHaveLength(1);
    expect(saga.withdrawals()[0]).toMatchObject({ id: withdrawal.id, status: "debited", providerPayoutId: saga.provider.payoutList()[0]?.id });
    saga.provider.settlePayouts();
    saga.clock.advanceMs(11_000);
    await sendPayouts(saga.deps, 10);
    expect(saga.withdrawals()[0]?.status).toBe("paid_out");
    expect(saga.outbox().map((row) => row.type)).toEqual(["si.chance.payments.WithdrawalSucceeded.v1"]);
  });

  it("never gives up reading a payout that exists: it only waits", async () => {
    const saga = await setupSaga();
    await withdrawalWithPayout(saga);
    for (let attempt = 1; attempt <= PAYOUT_ALERT_ATTEMPTS + 5; attempt += 1) {
      saga.provider.failNext(new PaymentProviderUnavailable("down"));
      saga.clock.advanceMs(10 * MINUTE);
      await sendPayouts(saga.deps, 10);
    }
    expect(saga.withdrawals()[0]).toMatchObject({ status: "debited" });
    expect(saga.withdrawals()[0]?.payoutAttempts).toBe(PAYOUT_ALERT_ATTEMPTS + 5);
  });

  it("does not apply the force-payout-failure flag to a withdrawal whose create was already sent (the answer was lost): the payout is attached instead", async () => {
    const saga = await setupSaga();
    const withdrawal = await debitedWithdrawal(saga);
    saga.provider.loseNextAnswers("createPayout", 1);
    await sendPayouts(saga.deps, 10);
    expect(saga.provider.payoutList()).toHaveLength(1);
    expect(saga.withdrawals()[0]).toMatchObject({ status: "debited", providerPayoutId: null });
    saga.settings.force = true;
    saga.clock.advanceMs(10 * MINUTE);
    await sendPayouts(saga.deps, 10);
    expect(saga.withdrawals()[0]).toMatchObject({ id: withdrawal.id, status: "debited", providerPayoutId: saga.provider.payoutList()[0]?.id });
    expect(saga.outbox()).toEqual([]);
    expect(saga.provider.payoutList()).toHaveLength(1);
  });

  it("does not apply the flag either after a crash between the create and the save of the payout id (the marker is set before the call)", async () => {
    const saga = await setupSaga();
    await debitedWithdrawal(saga);
    // The payout job claims the row and sends the create, then the process dies: no result is saved.
    const real = saga.store.tenantTransaction.bind(saga.store);
    let claims = 0;
    saga.store.tenantTransaction = ((tenantId: string, work: never) => {
      claims += 1;
      return claims > 1 ? Promise.reject(new Error("process died")) : real(tenantId, work);
    }) as never;
    await sendPayouts(saga.deps, 10);
    saga.store.tenantTransaction = real;
    expect(saga.provider.payoutList()).toHaveLength(1);
    expect(saga.withdrawals()[0]).toMatchObject({ status: "debited", providerPayoutId: null });
    expect(saga.withdrawals()[0]?.payoutRequestedAt).not.toBeNull();
    saga.settings.force = true;
    saga.clock.advanceMs(3 * MINUTE);
    await sendPayouts(saga.deps, 10);
    expect(saga.withdrawals()[0]?.providerPayoutId).toBe(saga.provider.payoutList()[0]?.id);
    expect(saga.outbox()).toEqual([]);
  });

  it("is not done twice by two replicas working at once", async () => {
    const saga = await setupSaga();
    await debitedWithdrawal(saga);
    const counts = await Promise.all([sendPayouts(saga.deps, 10), sendPayouts(saga.deps, 10)]);
    expect(counts.sort()).toEqual([0, 1]);
    expect(saga.provider.calls.filter((call) => call === "createPayout")).toHaveLength(1);
  });

  it("logs an unexpected error and goes on", async () => {
    const saga = await setupSaga();
    await debitedWithdrawal(saga);
    saga.provider.failNext(new TypeError("a bug"));
    expect(await sendPayouts(saga.deps, 10)).toBe(1);
    expect(saga.logger.lines.some((line) => line.level === "error")).toBe(true);
  });
});

describe("runDueWork", () => {
  it("runs the three jobs and reports how much each found", async () => {
    const saga = await setupSaga();
    await pendingDeposit(saga);
    saga.trading.answerNext({ kind: "unknown", reason: "timeout" });
    await requestWithdrawal(saga.deps, who("user-2"), { idempotencyKey: "k", amount: 100 });
    await debitedWithdrawal(saga, 100, "user-3");
    saga.clock.advanceMs(2 * MINUTE);
    expect(await runDueWork(saga.deps, 10)).toEqual({ deposits: 1, debits: 1, payouts: 2 });
  });

  it("logs a tenant whose work fails and still serves the others", async () => {
    const saga = await setupSaga();
    await debitedWithdrawal(saga);
    const real = saga.store.tenantTransaction.bind(saga.store);
    saga.store.tenantTransaction = ((tenantId: string, work: never) => (tenantId === TENANT_A ? Promise.reject(new Error("schema broke")) : real(tenantId, work))) as never;
    expect(await runDueWork(saga.deps, 10)).toEqual({ deposits: 0, debits: 0, payouts: 0 });
    expect(saga.logger.lines.filter((line) => line.level === "error")).toHaveLength(3);
  });
});
