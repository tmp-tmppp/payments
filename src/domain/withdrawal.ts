import { parseAmount } from "./amount.js";
import { DomainError } from "./errors.js";
import { LAST_ERROR_MAX_LENGTH, toStorableText } from "./text.js";

// A withdrawal (plan 6.6, FL-C):
//   requested -> debited -> paid_out
//   requested -> rejected
//   debited   -> failed -> refunded
// requested: stored, the debit at trading is not known to be done (a background job repeats it with the same key).
// debited: trading took the credits; the payout is sent by a background job. failed: the payout failed, WithdrawalFailed
// is out and trading refunds on its own. refunded: trading answered with WithdrawalRefunded and the saga ends.
export const WITHDRAWAL_STATUSES = ["requested", "debited", "paid_out", "rejected", "failed", "refunded"] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

/** insufficient_credits: trading answered 409. trading_unavailable: the circuit to trading was open before any call was sent. */
export const WITHDRAWAL_REJECT_REASONS = ["insufficient_credits", "trading_unavailable"] as const;
export type WithdrawalRejectReason = (typeof WITHDRAWAL_REJECT_REASONS)[number];

/**
 * forced: the force-payout-failure flag was on, payments declined the payout itself. declined: the provider declined it.
 * payout_lost: the provider no longer knows the payout (it answers 404). A payout that cannot be created is never given up:
 * a create call that got no answer may have reached the provider, so the job repeats it (same Idempotency-Key) and only alerts.
 */
export const WITHDRAWAL_FAILURE_REASONS = ["forced", "declined", "payout_lost"] as const;
export type WithdrawalFailureReason = (typeof WITHDRAWAL_FAILURE_REASONS)[number];

export type WithdrawalReason = WithdrawalRejectReason | WithdrawalFailureReason;

const TRANSITIONS: Readonly<Record<WithdrawalStatus, readonly WithdrawalStatus[]>> = {
  requested: ["debited", "rejected"],
  debited: ["paid_out", "failed"],
  paid_out: [],
  rejected: [],
  failed: ["refunded"],
  refunded: [],
};

export function canWithdrawalTransition(from: WithdrawalStatus, to: WithdrawalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The states that need no further step. A failed withdrawal is not final: it waits for the refund. */
export function isWithdrawalFinal(status: WithdrawalStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export interface Withdrawal {
  id: string;
  tenantId: string;
  userId: string;
  /** Credits = EUR cents. */
  amount: number;
  status: WithdrawalStatus;
  /** The Idempotency-Key of the request that made it; unique per user. */
  idempotencyKey: string;
  /** Digest of the request body: the same key with another body is a conflict. */
  requestHash: string;
  /** Set when the status is rejected, failed or refunded. */
  reason: WithdrawalReason | null;
  /** Id of the provider's payout; null until a payout was created. */
  providerPayoutId: string | null;
  /** Debit attempts that did not give a definitive answer, and when the background job tries next (status requested). */
  debitAttempts: number;
  nextDebitAt: Date | null;
  /** Payout steps that did not finish, and when the background job continues (status debited). */
  payoutAttempts: number;
  nextPayoutAt: Date | null;
  /**
   * Set by the payout job in the transaction that claims the withdrawal, BEFORE it calls the provider to create the payout.
   * From then on a create may have reached the provider (an answer can be lost, the process can die before it saves the
   * payout id), so the withdrawal can no longer be declined by the force-payout-failure flag: only the provider's answer ends it.
   */
  payoutRequestedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** When it reached paid_out, rejected or refunded. */
  completedAt: Date | null;
}

export interface NewWithdrawal {
  id: string;
  tenantId: string;
  userId: string;
  amount: unknown;
  idempotencyKey: string;
  requestHash: string;
  now: Date;
}

export function newWithdrawal(input: NewWithdrawal): Withdrawal {
  return {
    id: input.id,
    tenantId: input.tenantId,
    userId: input.userId,
    amount: parseAmount(input.amount),
    status: "requested",
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    reason: null,
    providerPayoutId: null,
    debitAttempts: 0,
    nextDebitAt: input.now,
    payoutAttempts: 0,
    nextPayoutAt: null,
    payoutRequestedAt: null,
    lastError: null,
    createdAt: input.now,
    updatedAt: input.now,
    completedAt: null,
  };
}

function transition(withdrawal: Withdrawal, to: WithdrawalStatus): void {
  if (!canWithdrawalTransition(withdrawal.status, to)) {
    throw new DomainError("illegal_transition", `A withdrawal cannot go from ${withdrawal.status} to ${to}`);
  }
}

/** Trading took the credits. The payout job takes over from now on. */
export function markDebited(withdrawal: Withdrawal, now: Date): Withdrawal {
  transition(withdrawal, "debited");
  return { ...withdrawal, status: "debited", nextDebitAt: null, nextPayoutAt: now, lastError: null, updatedAt: now };
}

/** Nothing was (or will be) debited. */
export function rejectWithdrawal(withdrawal: Withdrawal, reason: WithdrawalRejectReason, now: Date): Withdrawal {
  transition(withdrawal, "rejected");
  return { ...withdrawal, status: "rejected", reason, nextDebitAt: null, updatedAt: now, completedAt: now };
}

export function markPaidOut(withdrawal: Withdrawal, now: Date): Withdrawal {
  transition(withdrawal, "paid_out");
  return { ...withdrawal, status: "paid_out", nextPayoutAt: null, lastError: null, updatedAt: now, completedAt: now };
}

/** The payout did not happen. The refund is trading's reaction to the event this leads to. */
export function failWithdrawal(withdrawal: Withdrawal, reason: WithdrawalFailureReason, now: Date): Withdrawal {
  transition(withdrawal, "failed");
  return { ...withdrawal, status: "failed", reason, nextPayoutAt: null, updatedAt: now };
}

/** Trading refunded the credits (WithdrawalRefunded); the saga ends. The reason of the failure stays. */
export function markRefunded(withdrawal: Withdrawal, now: Date): Withdrawal {
  transition(withdrawal, "refunded");
  return { ...withdrawal, status: "refunded", updatedAt: now, completedAt: now };
}

/** Moves the next debit attempt without counting one (a lease while the job works). Only a requested withdrawal has a debit to repeat. */
export function deferDebit(withdrawal: Withdrawal, until: Date, now: Date): Withdrawal {
  if (withdrawal.status !== "requested") {
    throw new DomainError("illegal_transition", `A ${withdrawal.status} withdrawal has no debit to retry`);
  }
  return { ...withdrawal, nextDebitAt: until, updatedAt: now };
}

/** Moves the next payout step without counting one (a lease, or a wait for the provider to settle). Only a debited withdrawal has one. */
export function deferPayout(withdrawal: Withdrawal, until: Date, now: Date): Withdrawal {
  if (withdrawal.status !== "debited") {
    throw new DomainError("illegal_transition", `A ${withdrawal.status} withdrawal has no payout step`);
  }
  return { ...withdrawal, nextPayoutAt: until, updatedAt: now };
}

/** The payout job is about to create the payout at the provider: remember it (the first time only) and lease the row until `until`. */
export function markPayoutRequested(withdrawal: Withdrawal, until: Date, now: Date): Withdrawal {
  if (withdrawal.status !== "debited") {
    throw new DomainError("illegal_transition", `A ${withdrawal.status} withdrawal has no payout step`);
  }
  return { ...withdrawal, payoutRequestedAt: withdrawal.payoutRequestedAt ?? now, nextPayoutAt: until, updatedAt: now };
}

/** Stores the provider's payout id once the payout was created. The status stays debited until the provider settles it. */
export function attachPayout(withdrawal: Withdrawal, payoutId: string, now: Date): Withdrawal {
  if (withdrawal.status !== "debited") {
    throw new DomainError("illegal_transition", `A ${withdrawal.status} withdrawal cannot get a payout`);
  }
  if (withdrawal.providerPayoutId !== null && withdrawal.providerPayoutId !== payoutId) {
    throw new DomainError("illegal_transition", "The withdrawal already has another payout");
  }
  return { ...withdrawal, providerPayoutId: payoutId, updatedAt: now };
}

/** A debit call that gave no definitive answer: count it and say when the job tries again. Only a requested withdrawal is retried. */
export function recordDebitAttempt(withdrawal: Withdrawal, next: { at: Date; error: string }, now: Date): Withdrawal {
  if (withdrawal.status !== "requested") {
    throw new DomainError("illegal_transition", `A ${withdrawal.status} withdrawal has no debit to retry`);
  }
  return { ...withdrawal, debitAttempts: withdrawal.debitAttempts + 1, nextDebitAt: next.at, lastError: toStorableText(next.error, LAST_ERROR_MAX_LENGTH), updatedAt: now };
}

/** A payout step that did not finish: count it and say when the job continues. Only a debited withdrawal has a payout step. */
export function recordPayoutAttempt(withdrawal: Withdrawal, next: { at: Date; error: string }, now: Date): Withdrawal {
  if (withdrawal.status !== "debited") {
    throw new DomainError("illegal_transition", `A ${withdrawal.status} withdrawal has no payout step`);
  }
  return { ...withdrawal, payoutAttempts: withdrawal.payoutAttempts + 1, nextPayoutAt: next.at, lastError: toStorableText(next.error, LAST_ERROR_MAX_LENGTH), updatedAt: now };
}
