import { parseAmount } from "../domain/amount.js";
import { withdrawalFailedEvent, withdrawalSucceededEvent } from "../domain/events.js";
import {
  failWithdrawal,
  markDebited,
  markPaidOut,
  newWithdrawal,
  recordDebitAttempt,
  rejectWithdrawal,
} from "../domain/withdrawal.js";
import type { Withdrawal, WithdrawalFailureReason } from "../domain/withdrawal.js";
import { Conflict, InsufficientCredits, NotFound, TradingUnavailable, Unavailable, guardDomain } from "./errors.js";
import type { Caller, DebitOutcome, PaymentsDeps, PayoutStatus, TenantRepositories, UseCaseDeps } from "./ports.js";
import { addMs, backoffMs, checkIdempotencyKey, eventContext, outboxMessage, requestHash } from "./support.js";
import type { TenantCaller } from "./support.js";

/** A withdrawal that was just stored is not repeated by the job for this long: the request that stored it is still asking trading. */
export const DEBIT_GRACE_MS = 30_000;
export const DEBIT_RETRY_BASE_MS = 2000;
export const DEBIT_RETRY_MAX_MS = 60_000;

export interface WithdrawalResult {
  withdrawal: Withdrawal;
  /** True for the call that made it; false for a repeat of the same Idempotency-Key and body. */
  created: boolean;
}

/** The problem a rejected withdrawal is answered with (409 or 503), for the first call and for every repeat. */
export function rejectionOf(withdrawal: Withdrawal): InsufficientCredits | TradingUnavailable {
  return withdrawal.reason === "trading_unavailable" ? new TradingUnavailable(withdrawal.id) : new InsufficientCredits(withdrawal.id);
}

async function replayOf(repos: TenantRepositories, caller: TenantCaller, key: string, hash: string): Promise<Withdrawal | null> {
  const existing = await repos.withdrawals.findByIdempotencyKey(caller.userId, key);
  if (existing === null) return null;
  if (existing.requestHash !== hash) {
    throw new Conflict("idempotency_key_reused", "The Idempotency-Key was used before with another request body");
  }
  return existing;
}

/**
 * What a debit answer does to a requested withdrawal. `request`: the call that made the withdrawal, which owes its caller
 * an answer (an open circuit means rejected, the caller is told to come back). `job`: the repeat of a debit whose outcome
 * was unknown; the caller was already promised the status link, so an open circuit only means "try again later".
 * Anything but a requested withdrawal is left as it is: the other path was first.
 */
export async function applyDebitOutcome(
  repos: TenantRepositories,
  current: Withdrawal,
  outcome: DebitOutcome,
  mode: "request" | "job",
  now: Date,
): Promise<Withdrawal> {
  if (current.status !== "requested") return current;
  let next: Withdrawal;
  switch (outcome.kind) {
    case "debited":
      next = guardDomain(() => markDebited(current, now));
      break;
    case "insufficient":
      next = guardDomain(() => rejectWithdrawal(current, "insufficient_credits", now));
      break;
    case "circuit_open":
      next =
        mode === "request"
          ? guardDomain(() => rejectWithdrawal(current, "trading_unavailable", now))
          : guardDomain(() => recordDebitAttempt(current, { at: addMs(now, backoffMs(current.debitAttempts, DEBIT_RETRY_BASE_MS, DEBIT_RETRY_MAX_MS)), error: "circuit to trading is open" }, now));
      break;
    case "unknown":
      next = guardDomain(() =>
        recordDebitAttempt(current, { at: addMs(now, backoffMs(current.debitAttempts, DEBIT_RETRY_BASE_MS, DEBIT_RETRY_MAX_MS)), error: outcome.reason.slice(0, 500) }, now),
      );
      break;
  }
  await repos.withdrawals.save(next);
  return next;
}

/**
 * Request a withdrawal (FL-C steps 1 to 3).
 * 1. The withdrawal is stored as `requested` and committed, before trading hears of it.
 * 2. Trading is asked to debit the credits, idempotent by the withdrawal id.
 * 3. The answer decides: debited -> `debited`, 202; 409 -> `rejected`, 409; the circuit was already open before any call was
 *    sent -> `rejected`, 503 with Retry-After; a timeout or a lost answer after sending -> the withdrawal stays `requested`
 *    and the answer is 202 with the status link, and the debit job repeats the debit with the same key until trading answers.
 * A rejection is thrown as `InsufficientCredits` or `TradingUnavailable` (they carry the stored withdrawal's id).
 */
export async function requestWithdrawal(
  deps: PaymentsDeps,
  caller: TenantCaller,
  input: { idempotencyKey: unknown; amount: unknown },
): Promise<WithdrawalResult> {
  checkIdempotencyKey(input.idempotencyKey);
  const key = input.idempotencyKey;
  const amount = guardDomain(() => parseAmount(input.amount));
  const hash = requestHash({ amount });

  const stored = await deps.store.tenantTransaction(caller.tenantId, async (repos): Promise<WithdrawalResult> => {
    const replay = await replayOf(repos, caller, key, hash);
    if (replay) return { withdrawal: replay, created: false };
    const now = deps.clock.now();
    const requested = guardDomain(() =>
      newWithdrawal({ id: deps.ids.newId(), tenantId: caller.tenantId, userId: caller.userId, amount, idempotencyKey: key, requestHash: hash, now }),
    );
    const fresh: Withdrawal = { ...requested, nextDebitAt: addMs(now, DEBIT_GRACE_MS) };
    if (!(await repos.withdrawals.insert(fresh))) {
      const raced = await replayOf(repos, caller, key, hash);
      if (raced === null) throw new Unavailable("withdrawal_busy", "The withdrawal of this Idempotency-Key is not readable yet, try again", 1);
      return { withdrawal: raced, created: false };
    }
    return { withdrawal: fresh, created: true };
  });

  if (!stored.created) {
    // A repeat answers with the withdrawal as it is now; a rejected one repeats its 409 or 503.
    if (stored.withdrawal.status === "rejected") throw rejectionOf(stored.withdrawal);
    return stored;
  }

  const outcome = await deps.trading.debit({ withdrawalId: stored.withdrawal.id, tenantId: caller.tenantId, userId: caller.userId, amount, correlationId: caller.correlationId });

  const updated = await deps.store.tenantTransaction(caller.tenantId, async (repos) => {
    const current = await repos.withdrawals.get(stored.withdrawal.id, { forUpdate: true });
    if (current === null) throw new Error(`The withdrawal ${stored.withdrawal.id} vanished`);
    return applyDebitOutcome(repos, current, outcome, "request", deps.clock.now());
  });
  if (updated.status === "rejected") throw rejectionOf(updated);
  return { withdrawal: updated, created: true };
}

/** One withdrawal of the caller; another user's or another tenant's withdrawal does not exist as far as the caller can tell. */
export async function getWithdrawal(deps: UseCaseDeps, caller: TenantCaller, id: string): Promise<Withdrawal> {
  const withdrawal = await deps.store.tenantTransaction(caller.tenantId, (repos) => repos.withdrawals.get(id));
  if (withdrawal === null || withdrawal.userId !== caller.userId) throw new NotFound("withdrawal_not_found", "No such withdrawal");
  return withdrawal;
}

export type WithdrawalSettlement = { to: "paid_out" } | { to: "failed"; reason: WithdrawalFailureReason };

/** What a payout state means for its withdrawal; a pending payout means nothing yet. */
export function withdrawalSettlementFor(status: PayoutStatus): WithdrawalSettlement | null {
  switch (status) {
    case "paid":
      return { to: "paid_out" };
    case "failed":
      return { to: "failed", reason: "declined" };
    case "pending":
      return null;
  }
}

/**
 * Moves a debited withdrawal to its end state and writes the event in the same transaction (REL-01). A failed payout
 * also writes one warn line that starts with "WithdrawalFailed": the central logging alert (REQ-19) matches that text,
 * so it does not depend on trading's line when trading consumes the event.
 */
export async function settleWithdrawal(
  repos: TenantRepositories,
  deps: Pick<UseCaseDeps, "ids" | "logger">,
  withdrawal: Withdrawal,
  settlement: WithdrawalSettlement,
  trigger: Caller,
  now: Date,
): Promise<Withdrawal> {
  const ctx = eventContext(deps, trigger, now);
  if (settlement.to === "paid_out") {
    const settled = guardDomain(() => markPaidOut(withdrawal, now));
    await repos.withdrawals.save(settled);
    await repos.outbox.add(outboxMessage("WithdrawalSucceeded", withdrawalSucceededEvent(settled, now, ctx), settled.id, now));
    return settled;
  }
  const settled = guardDomain(() => failWithdrawal(withdrawal, settlement.reason, now));
  await repos.withdrawals.save(settled);
  await repos.outbox.add(outboxMessage("WithdrawalFailed", withdrawalFailedEvent(settled, settlement.reason, now, ctx), settled.id, now));
  deps.logger.warn(
    { withdrawalId: settled.id, tenantId: settled.tenantId, correlationId: ctx.correlationId, reason: settlement.reason },
    "WithdrawalFailed: payout failed, refund requested",
  );
  return settled;
}

/** The job waits this long before it looks at a pending payout again. */
export const PAYOUT_POLL_MS = 10_000;
