import { describe, expect, it } from "vitest";
import { Conflict, InsufficientCredits, NotFound, TenantNotReady, TradingUnavailable, ValidationFailed } from "../../src/usecases/errors.js";
import { getWithdrawal, requestWithdrawal } from "../../src/usecases/withdrawals.js";
import { TENANT_A, TENANT_B, who } from "../support/harness.js";
import { setupSaga } from "../support/saga.js";

describe("requestWithdrawal", () => {
  it("debits at trading with the withdrawal id, tenant, user, amount and the caller's correlation id, and answers debited", async () => {
    const { deps, trading, withdrawals } = await setupSaga();
    const caller = who();
    const { withdrawal, created } = await requestWithdrawal(deps, caller, { idempotencyKey: "k1", amount: 1800 });

    expect(created).toBe(true);
    expect(withdrawal).toMatchObject({ status: "debited", amount: 1800, reason: null, nextDebitAt: null });
    expect(trading.requests).toEqual([{ withdrawalId: withdrawal.id, tenantId: TENANT_A, userId: "user-1", amount: 1800, correlationId: caller.correlationId }]);
    expect(trading.creditsOf(TENANT_A, "user-1")).toBe(1_000_000 - 1800);
    expect(withdrawals()).toHaveLength(1);
  });

  it("rejects the withdrawal when trading answers 409, and says so to the caller with the withdrawal's id", async () => {
    const { deps, trading, withdrawals } = await setupSaga();
    trading.setCredits(TENANT_A, "user-1", 100);
    const failure = await requestWithdrawal(deps, who(), { idempotencyKey: "k1", amount: 500 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InsufficientCredits);
    expect(failure).toMatchObject({ kind: "conflict", code: "insufficient_credits", withdrawalId: withdrawals()[0]?.id });
    expect(withdrawals()[0]).toMatchObject({ status: "rejected", reason: "insufficient_credits" });
    expect(withdrawals()[0]?.completedAt).not.toBeNull();
    expect(trading.creditsOf(TENANT_A, "user-1")).toBe(100);
  });

  it("repeats the 409 of a rejected withdrawal for the same key and does not ask trading again", async () => {
    const { deps, trading, withdrawals } = await setupSaga();
    trading.setCredits(TENANT_A, "user-1", 100);
    await requestWithdrawal(deps, who(), { idempotencyKey: "k1", amount: 500 }).catch(() => undefined);
    const again = await requestWithdrawal(deps, who(), { idempotencyKey: "k1", amount: 500 }).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(InsufficientCredits);
    expect((again as InsufficientCredits).withdrawalId).toBe(withdrawals()[0]?.id);
    expect(trading.requests).toHaveLength(1);
  });

  it("rejects with 503 when the circuit to trading was open before any call was sent: nothing is debited", async () => {
    const { deps, trading, withdrawals } = await setupSaga();
    trading.answerNext({ kind: "circuit_open" });
    const failure = await requestWithdrawal(deps, who(), { idempotencyKey: "k1", amount: 500 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TradingUnavailable);
    expect(failure).toMatchObject({ kind: "unavailable", code: "trading_unavailable", retryAfterSeconds: 10, withdrawalId: withdrawals()[0]?.id });
    expect(withdrawals()[0]).toMatchObject({ status: "rejected", reason: "trading_unavailable" });
    expect(trading.creditsOf(TENANT_A, "user-1")).toBe(1_000_000);

    const again = await requestWithdrawal(deps, who(), { idempotencyKey: "k1", amount: 500 }).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(TradingUnavailable);
  });

  it("keeps the withdrawal requested when the answer is lost after sending, and answers with it (202 at the edge)", async () => {
    const { deps, trading, clock } = await setupSaga();
    trading.loseNextAnswers(1);
    const { withdrawal, created } = await requestWithdrawal(deps, who(), { idempotencyKey: "k1", amount: 500 });

    expect(created).toBe(true);
    expect(withdrawal).toMatchObject({ status: "requested", debitAttempts: 1, lastError: "the answer was lost" });
    expect(withdrawal.nextDebitAt?.getTime()).toBe(clock.now().getTime() + 2000);
    // Trading did take the credits: that is why the debit is repeated with the same key, never abandoned.
    expect(trading.hasDebited(withdrawal.id)).toBe(true);
  });

  it("answers a repeat of the same key and body with the same withdrawal and calls trading once", async () => {
    const { deps, trading } = await setupSaga();
    trading.loseNextAnswers(1);
    const first = await requestWithdrawal(deps, who(), { idempotencyKey: "k1", amount: 500 });
    const again = await requestWithdrawal(deps, who(), { idempotencyKey: "k1", amount: 500 });
    expect(again.created).toBe(false);
    expect(again.withdrawal.id).toBe(first.withdrawal.id);
    expect(trading.requests).toHaveLength(1);
  });

  it("refuses the same key with another body, and takes the same key from another user", async () => {
    const { deps } = await setupSaga();
    await requestWithdrawal(deps, who(), { idempotencyKey: "k1", amount: 500 });
    await expect(requestWithdrawal(deps, who(), { idempotencyKey: "k1", amount: 501 })).rejects.toBeInstanceOf(Conflict);
    expect((await requestWithdrawal(deps, who("user-2"), { idempotencyKey: "k1", amount: 501 })).created).toBe(true);
  });

  it("makes one withdrawal and one debit when the same key arrives twice at once", async () => {
    const { deps, trading, withdrawals } = await setupSaga();
    const results = await Promise.all([
      requestWithdrawal(deps, who(), { idempotencyKey: "same", amount: 500 }),
      requestWithdrawal(deps, who(), { idempotencyKey: "same", amount: 500 }),
    ]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(trading.requests).toHaveLength(1);
    expect(withdrawals()).toHaveLength(1);
  });

  it.each([0, 1.5, 1_000_001, "5", undefined])("refuses the amount %s before anything is stored or sent", async (amount) => {
    const { deps, trading, withdrawals } = await setupSaga();
    await expect(requestWithdrawal(deps, who(), { idempotencyKey: "k", amount })).rejects.toBeInstanceOf(ValidationFailed);
    expect(trading.requests).toEqual([]);
    expect(withdrawals()).toEqual([]);
  });

  it("refuses a bad Idempotency-Key, and a tenant without a schema", async () => {
    const { deps } = await setupSaga();
    await expect(requestWithdrawal(deps, who(), { idempotencyKey: "no spaces", amount: 5 })).rejects.toBeInstanceOf(ValidationFailed);
    await expect(requestWithdrawal(deps, who("user-1", "018f3c1e-7a00-7000-8000-0000000000cc"), { idempotencyKey: "k", amount: 5 })).rejects.toBeInstanceOf(TenantNotReady);
  });

  it("is not stolen by the job while the request that stored it is still asking trading", async () => {
    const { deps, withdrawals, clock } = await setupSaga();
    // The row as the first step leaves it, before trading answers: due only after the grace period.
    let sawRow: Date | null = null;
    const slow = { debit: () => { sawRow = withdrawals()[0]?.nextDebitAt ?? null; return Promise.resolve({ kind: "debited" } as const); } };
    await requestWithdrawal({ ...deps, trading: slow }, who(), { idempotencyKey: "k", amount: 5 });
    expect((sawRow as Date | null)?.getTime()).toBe(clock.now().getTime() + 30_000);
  });
});

describe("getWithdrawal", () => {
  it("returns the caller's own and hides everyone else's", async () => {
    const { deps } = await setupSaga();
    const { withdrawal } = await requestWithdrawal(deps, who(), { idempotencyKey: "k", amount: 500 });
    expect((await getWithdrawal(deps, who(), withdrawal.id)).id).toBe(withdrawal.id);
    await expect(getWithdrawal(deps, who("user-2"), withdrawal.id)).rejects.toBeInstanceOf(NotFound);
    await expect(getWithdrawal(deps, who("user-1", TENANT_B), withdrawal.id)).rejects.toBeInstanceOf(NotFound);
    await expect(getWithdrawal(deps, who(), "nope")).rejects.toMatchObject({ code: "withdrawal_not_found" });
  });
});
