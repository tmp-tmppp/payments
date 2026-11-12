import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { deferDepositCheck, failDeposit, newDeposit } from "../../src/domain/deposit.js";
import { deferDebit, deferPayout, markDebited, markPaidOut, newWithdrawal, rejectWithdrawal } from "../../src/domain/withdrawal.js";

const now = new Date("2026-11-01T10:00:00.000Z");
const later = new Date("2026-11-01T10:05:00.000Z");
const base = { tenantId: "t", userId: "u", amount: 500, idempotencyKey: "k", requestHash: "h", now };

describe("deferring the next look of a job", () => {
  it("moves only the next time of a pending deposit", () => {
    const deposit = newDeposit({ ...base, id: "d1" });
    expect(deferDepositCheck(deposit, later, later)).toEqual({ ...deposit, nextCheckAt: later, updatedAt: later });
    expect(() => deferDepositCheck(failDeposit(deposit, "declined", now), later, later)).toThrow(DomainError);
  });

  it("moves the next debit of a requested withdrawal without counting an attempt, and refuses any other state", () => {
    const withdrawal = newWithdrawal({ ...base, id: "w1" });
    expect(deferDebit(withdrawal, later, later)).toEqual({ ...withdrawal, nextDebitAt: later, updatedAt: later });
    expect(() => deferDebit(markDebited(withdrawal, now), later, later)).toThrow(DomainError);
    expect(() => deferDebit(rejectWithdrawal(withdrawal, "insufficient_credits", now), later, later)).toThrow(DomainError);
  });

  it("moves the next payout step of a debited withdrawal without counting an attempt, and refuses any other state", () => {
    const debited = markDebited(newWithdrawal({ ...base, id: "w1" }), now);
    expect(deferPayout(debited, later, later)).toEqual({ ...debited, nextPayoutAt: later, updatedAt: later });
    expect(() => deferPayout(newWithdrawal({ ...base, id: "w2" }), later, later)).toThrow(DomainError);
    expect(() => deferPayout(markPaidOut(debited, now), later, later)).toThrow(DomainError);
  });
});
