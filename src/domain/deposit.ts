import { parseAmount } from "./amount.js";
import { DomainError } from "./errors.js";
import { LAST_ERROR_MAX_LENGTH, toStorableText } from "./text.js";

// A deposit: pending -> succeeded | failed. Both end states are final. The provider's webhook (after a read back of the
// checkout session) or the expiry job moves it; nothing else does.
export const DEPOSIT_STATUSES = ["pending", "succeeded", "failed"] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

/**
 * declined: the buyer pressed Decline. expired: the provider says the session ran out (or no longer knows it). provider_unavailable:
 * the provider could not be reached for the whole 30 minutes, so no checkout session was ever made and the buyer has no link.
 */
export const DEPOSIT_FAILURE_REASONS = ["declined", "expired", "provider_unavailable"] as const;
export type DepositFailureReason = (typeof DEPOSIT_FAILURE_REASONS)[number];

/**
 * How long a deposit may wait for its checkout session: a pending deposit that still has none after this long (the provider
 * could not be reached) fails with provider_unavailable. A deposit that has a session is never failed on this clock: only the
 * provider's answer (expired, declined, unknown) ends it, and completed always wins.
 */
export const DEPOSIT_EXPIRY_MINUTES = 30;

const TRANSITIONS: Readonly<Record<DepositStatus, readonly DepositStatus[]>> = {
  pending: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

export function canDepositTransition(from: DepositStatus, to: DepositStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface Deposit {
  id: string;
  tenantId: string;
  userId: string;
  /** Credits = EUR cents. */
  amount: number;
  status: DepositStatus;
  /** The Idempotency-Key of the request that made it; unique per user. */
  idempotencyKey: string;
  /** Digest of the request body: the same key with another body is a conflict. */
  requestHash: string;
  /** Id of the provider's checkout session; null until the provider answered. */
  providerSessionId: string | null;
  /** Where the buyer pays; null until the provider answered. */
  checkoutUrl: string | null;
  /** Set when the status is failed. */
  failureReason: DepositFailureReason | null;
  /** From this time on the expiry job may expire the deposit. */
  expiresAt: Date;
  /** Reconciliation job (status pending): looks at the provider that did not give a plain "open" answer, and when the job looks next. */
  checkAttempts: number;
  nextCheckAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** When it reached succeeded or failed. */
  completedAt: Date | null;
}

export interface NewDeposit {
  id: string;
  tenantId: string;
  userId: string;
  amount: unknown;
  idempotencyKey: string;
  requestHash: string;
  now: Date;
}

export function newDeposit(input: NewDeposit): Deposit {
  const expiresAt = new Date(input.now.getTime() + DEPOSIT_EXPIRY_MINUTES * 60_000);
  return {
    id: input.id,
    tenantId: input.tenantId,
    userId: input.userId,
    amount: parseAmount(input.amount),
    status: "pending",
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    providerSessionId: null,
    checkoutUrl: null,
    failureReason: null,
    expiresAt,
    checkAttempts: 0,
    nextCheckAt: expiresAt,
    lastError: null,
    createdAt: input.now,
    updatedAt: input.now,
    completedAt: null,
  };
}

function transition(deposit: Deposit, to: DepositStatus): void {
  if (!canDepositTransition(deposit.status, to)) {
    throw new DomainError("illegal_transition", `A deposit cannot go from ${deposit.status} to ${to}`);
  }
}

/** Stores what the provider answered to the checkout request. Only a pending deposit gets a session, and only one. */
export function attachCheckoutSession(deposit: Deposit, session: { id: string; url: string }, now: Date): Deposit {
  if (deposit.status !== "pending") {
    throw new DomainError("illegal_transition", `A ${deposit.status} deposit cannot get a checkout session`);
  }
  if (deposit.providerSessionId !== null) {
    throw new DomainError("illegal_transition", "The deposit already has a checkout session");
  }
  return { ...deposit, providerSessionId: session.id, checkoutUrl: session.url, updatedAt: now };
}

export function succeedDeposit(deposit: Deposit, now: Date): Deposit {
  transition(deposit, "succeeded");
  return { ...deposit, status: "succeeded", failureReason: null, nextCheckAt: null, lastError: null, updatedAt: now, completedAt: now };
}

export function failDeposit(deposit: Deposit, reason: DepositFailureReason, now: Date): Deposit {
  transition(deposit, "failed");
  return { ...deposit, status: "failed", failureReason: reason, nextCheckAt: null, updatedAt: now, completedAt: now };
}

/** A look at the provider that ended without a verdict (no answer, or the session still open): count it and say when the job looks again. Only a pending deposit is looked at. */
export function recordDepositCheck(deposit: Deposit, next: { at: Date; error: string | null }, now: Date): Deposit {
  if (deposit.status !== "pending") {
    throw new DomainError("illegal_transition", `A ${deposit.status} deposit has nothing to check`);
  }
  const lastError = next.error === null ? null : toStorableText(next.error, LAST_ERROR_MAX_LENGTH);
  return { ...deposit, checkAttempts: deposit.checkAttempts + 1, nextCheckAt: next.at, lastError, updatedAt: now };
}

/** Moves the next look of the background job (a lease while it works, or the next reconciliation). Only a pending deposit has one. */
export function deferDepositCheck(deposit: Deposit, until: Date, now: Date): Deposit {
  if (deposit.status !== "pending") {
    throw new DomainError("illegal_transition", `A ${deposit.status} deposit has nothing to check`);
  }
  return { ...deposit, nextCheckAt: until, updatedAt: now };
}

/** True while the deposit is pending and its 30 minutes are over (it matters only for a deposit that has no session). */
export function isDepositExpired(deposit: Deposit, now: Date): boolean {
  return deposit.status === "pending" && now.getTime() >= deposit.expiresAt.getTime();
}
