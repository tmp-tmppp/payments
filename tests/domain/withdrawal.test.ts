import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  WITHDRAWAL_FAILURE_REASONS,
  WITHDRAWAL_REJECT_REASONS,
  WITHDRAWAL_STATUSES,
  attachPayout,
  canWithdrawalTransition,
  failWithdrawal,
  isWithdrawalFinal,
  markDebited,
  markPaidOut,
  markRefunded,
  newWithdrawal,
  recordDebitAttempt,
  recordPayoutAttempt,
  rejectWithdrawal,
} from "../../src/domain/withdrawal.js";
import type { Withdrawal, WithdrawalStatus } from "../../src/domain/withdrawal.js";

const T0 = new Date("2026-11-01T10:00:00.000Z");
const T1 = new Date("2026-11-01T10:00:05.000Z");
const T2 = new Date("2026-11-01T10:00:10.000Z");

const requested = (): Withdrawal =>
  newWithdrawal({
    id: "00000000-0000-7000-8000-000000000002",
    tenantId: "018f3c1e-7a00-7000-8000-0000000000aa",
    userId: "user-1",
    amount: 1800,
    idempotencyKey: "key-1",
    requestHash: "hash-1",
    now: T0,
  });
const debited = (): Withdrawal => markDebited(requested(), T1);
const paidOut = (): Withdrawal => markPaidOut(debited(), T2);
const rejected = (): Withdrawal => rejectWithdrawal(requested(), "insufficient_credits", T1);
const failed = (): Withdrawal => failWithdrawal(debited(), "declined", T2);
const refunded = (): Withdrawal => markRefunded(failed(), T2);

describe("newWithdrawal", () => {
  it("starts requested, due for the debit at once, with nothing else set", () => {
    expect(requested()).toMatchObject({
      status: "requested",
      amount: 1800,
      reason: null,
      providerPayoutId: null,
      debitAttempts: 0,
      nextDebitAt: T0,
      payoutAttempts: 0,
      nextPayoutAt: null,
      lastError: null,
      completedAt: null,
      createdAt: T0,
    });
  });

  it("refuses an invalid amount", () => {
    for (const amount of [0, -3, 2.5, 1_000_001, "7", null]) {
      expect(() => newWithdrawal({ ...requested(), amount, now: T0 })).toThrow(expect.objectContaining({ code: "invalid_amount" }));
    }
  });
});

describe("withdrawal transitions", () => {
  const legal: Array<[WithdrawalStatus, WithdrawalStatus]> = [
    ["requested", "debited"],
    ["requested", "rejected"],
    ["debited", "paid_out"],
    ["debited", "failed"],
    ["failed", "refunded"],
  ];

  it("allows exactly the five legal transitions of the plan and no other pair", () => {
    for (const from of WITHDRAWAL_STATUSES) {
      for (const to of WITHDRAWAL_STATUSES) {
        expect(canWithdrawalTransition(from, to), `${from} -> ${to}`).toBe(legal.some(([a, b]) => a === from && b === to));
      }
    }
  });

  it("treats failed as not final and the other ends as final", () => {
    expect(WITHDRAWAL_STATUSES.filter((status) => isWithdrawalFinal(status))).toEqual(["paid_out", "rejected", "refunded"]);
  });

  it("requested -> debited hands the work from the debit job to the payout job", () => {
    expect(debited()).toMatchObject({ status: "debited", nextDebitAt: null, nextPayoutAt: T1, lastError: null, updatedAt: T1, completedAt: null });
  });

  it.each(WITHDRAWAL_REJECT_REASONS)("requested -> rejected with reason %s ends it", (reason) => {
    expect(rejectWithdrawal(requested(), reason, T1)).toMatchObject({ status: "rejected", reason, nextDebitAt: null, completedAt: T1 });
  });

  it("debited -> paid_out ends it and clears the payout job", () => {
    expect(paidOut()).toMatchObject({ status: "paid_out", nextPayoutAt: null, completedAt: T2, reason: null });
  });

  it.each(WITHDRAWAL_FAILURE_REASONS)("debited -> failed with reason %s does not end it", (reason) => {
    expect(failWithdrawal(debited(), reason, T2)).toMatchObject({ status: "failed", reason, nextPayoutAt: null, completedAt: null });
  });

  it("failed -> refunded ends it and keeps the reason of the failure", () => {
    expect(refunded()).toMatchObject({ status: "refunded", reason: "declined", completedAt: T2 });
  });

  it("does not change the withdrawal it was given", () => {
    const withdrawal = requested();
    markDebited(withdrawal, T1);
    rejectWithdrawal(withdrawal, "trading_unavailable", T1);
    expect(withdrawal.status).toBe("requested");
  });

  const illegal: Array<[string, () => Withdrawal]> = [
    ["debit a debited withdrawal", () => markDebited(debited(), T2)],
    ["debit a rejected withdrawal", () => markDebited(rejected(), T2)],
    ["debit a paid out withdrawal", () => markDebited(paidOut(), T2)],
    ["debit a failed withdrawal", () => markDebited(failed(), T2)],
    ["debit a refunded withdrawal", () => markDebited(refunded(), T2)],
    ["reject a debited withdrawal", () => rejectWithdrawal(debited(), "insufficient_credits", T2)],
    ["reject a rejected withdrawal", () => rejectWithdrawal(rejected(), "insufficient_credits", T2)],
    ["reject a paid out withdrawal", () => rejectWithdrawal(paidOut(), "insufficient_credits", T2)],
    ["reject a failed withdrawal", () => rejectWithdrawal(failed(), "insufficient_credits", T2)],
    ["reject a refunded withdrawal", () => rejectWithdrawal(refunded(), "insufficient_credits", T2)],
    ["pay out a requested withdrawal", () => markPaidOut(requested(), T2)],
    ["pay out a paid out withdrawal", () => markPaidOut(paidOut(), T2)],
    ["pay out a rejected withdrawal", () => markPaidOut(rejected(), T2)],
    ["pay out a failed withdrawal", () => markPaidOut(failed(), T2)],
    ["pay out a refunded withdrawal", () => markPaidOut(refunded(), T2)],
    ["fail a requested withdrawal", () => failWithdrawal(requested(), "forced", T2)],
    ["fail a failed withdrawal", () => failWithdrawal(failed(), "forced", T2)],
    ["fail a paid out withdrawal", () => failWithdrawal(paidOut(), "forced", T2)],
    ["fail a rejected withdrawal", () => failWithdrawal(rejected(), "forced", T2)],
    ["fail a refunded withdrawal", () => failWithdrawal(refunded(), "forced", T2)],
    ["refund a requested withdrawal", () => markRefunded(requested(), T2)],
    ["refund a debited withdrawal", () => markRefunded(debited(), T2)],
    ["refund a paid out withdrawal", () => markRefunded(paidOut(), T2)],
    ["refund a rejected withdrawal", () => markRefunded(rejected(), T2)],
    ["refund a refunded withdrawal", () => markRefunded(refunded(), T2)],
  ];

  it.each(illegal)("refuses to %s", (_label, run) => {
    expect(run).toThrow(DomainError);
    expect(run).toThrow(expect.objectContaining({ code: "illegal_transition" }));
  });
});

describe("attachPayout", () => {
  it("stores the payout id of a debited withdrawal and leaves the status", () => {
    expect(attachPayout(debited(), "po_1", T2)).toMatchObject({ status: "debited", providerPayoutId: "po_1", updatedAt: T2 });
  });

  it("accepts the same payout id again (a repeated job step) but not another one", () => {
    const once = attachPayout(debited(), "po_1", T2);
    expect(attachPayout(once, "po_1", T2).providerPayoutId).toBe("po_1");
    expect(() => attachPayout(once, "po_2", T2)).toThrow(/already has another payout/);
  });

  it.each([
    ["requested", requested],
    ["paid out", paidOut],
    ["rejected", rejected],
    ["failed", failed],
    ["refunded", refunded],
  ])("refuses a %s withdrawal", (_label, make) => {
    expect(() => attachPayout(make(), "po_1", T2)).toThrow(expect.objectContaining({ code: "illegal_transition" }));
  });
});

describe("job bookkeeping", () => {
  it("counts a debit call without a definitive answer and moves the next try", () => {
    const next = new Date("2026-11-01T10:00:30.000Z");
    const once = recordDebitAttempt(requested(), { at: next, error: "timeout" }, T1);
    const twice = recordDebitAttempt(once, { at: new Date(next.getTime() + 1000), error: "503" }, T2);
    expect(once).toMatchObject({ status: "requested", debitAttempts: 1, nextDebitAt: next, lastError: "timeout" });
    expect(twice).toMatchObject({ debitAttempts: 2, lastError: "503" });
  });

  it("keeps a storable last error: NUL and lone surrogates become U+FFFD, at most 500 units, a pair cut in half too", () => {
    const next = new Date("2026-11-01T10:00:30.000Z");
    expect(recordDebitAttempt(requested(), { at: next, error: "bad\u0000detail \ud800" }, T1).lastError).toBe("bad�detail �");
    const cut = recordPayoutAttempt(debited(), { at: next, error: `${"x".repeat(499)}😀 tail` }, T2).lastError;
    expect(cut).toBe(`${"x".repeat(499)}�`);
    expect(recordDebitAttempt(requested(), { at: next, error: "upstream 😀 ok" }, T1).lastError).toBe("upstream 😀 ok");
  });

  it("counts a payout step that did not finish and moves the next one", () => {
    const next = new Date("2026-11-01T10:01:00.000Z");
    expect(recordPayoutAttempt(debited(), { at: next, error: "provider down" }, T2)).toMatchObject({
      status: "debited",
      payoutAttempts: 1,
      nextPayoutAt: next,
      lastError: "provider down",
    });
  });

  it.each([
    ["debited", debited],
    ["paid out", paidOut],
    ["rejected", rejected],
    ["failed", failed],
    ["refunded", refunded],
  ])("has no debit to retry on a %s withdrawal", (_label, make) => {
    expect(() => recordDebitAttempt(make(), { at: T2, error: "x" }, T2)).toThrow(expect.objectContaining({ code: "illegal_transition" }));
  });

  it.each([
    ["requested", requested],
    ["paid out", paidOut],
    ["rejected", rejected],
    ["failed", failed],
    ["refunded", refunded],
  ])("has no payout step on a %s withdrawal", (_label, make) => {
    expect(() => recordPayoutAttempt(make(), { at: T2, error: "x" }, T2)).toThrow(expect.objectContaining({ code: "illegal_transition" }));
  });
});
