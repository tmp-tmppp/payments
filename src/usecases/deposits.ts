import { parseAmount } from "../domain/amount.js";
import { attachCheckoutSession, deferDepositCheck, failDeposit, newDeposit, succeedDeposit } from "../domain/deposit.js";
import type { Deposit, DepositFailureReason } from "../domain/deposit.js";
import { depositFailedEvent, depositSucceededEvent } from "../domain/events.js";
import { Conflict, NotFound, Unavailable, guardDomain } from "./errors.js";
import type { Caller, CheckoutSessionStatus, PaymentsDeps, ProviderCheckoutSession, TenantRepositories, UseCaseDeps } from "./ports.js";
import { addMs, checkIdempotencyKey, eventContext, outboxMessage, providerFailure, requestHash } from "./support.js";
import type { TenantCaller } from "./support.js";

/**
 * While a deposit waits for the buyer, the job reads its session back with growing waits (1, 2, 5, 10, then every 20 minutes),
 * so that a lost webhook costs minutes and one deposit does not cost a provider call a minute. `attempts` is the number of
 * looks so far: the first look is a minute after the deposit was made.
 */
const RECONCILE_STEPS_MS = [60_000, 120_000, 300_000, 600_000, 1_200_000];
export const reconcileDelayMs = (attempts: number): number => RECONCILE_STEPS_MS[Math.min(attempts, RECONCILE_STEPS_MS.length - 1)] ?? 1_200_000;

export interface DepositResult {
  deposit: Deposit;
  /** True for the call that made it; false for a repeat of the same Idempotency-Key and body. */
  created: boolean;
}

/** Same key, same user: the same body answers with the deposit made the first time, another body is a conflict. */
async function replayOf(repos: TenantRepositories, caller: TenantCaller, key: string, hash: string): Promise<Deposit | null> {
  const existing = await repos.deposits.findByIdempotencyKey(caller.userId, key);
  if (existing === null) return null;
  if (existing.requestHash !== hash) {
    throw new Conflict("idempotency_key_reused", "The Idempotency-Key was used before with another request body");
  }
  return existing;
}

/**
 * Start a deposit (FL-B step 1) in three steps and no database transaction open across the provider call: (1) the pending
 * deposit is stored and committed, (2) the provider is asked for a checkout session with no transaction held (the deposit id
 * is its idempotency key, so a repeat returns the same session), (3) the session is attached in a second transaction. If the
 * provider is down the call fails with 503 and Retry-After and the deposit stays pending without a session: a repeat of the
 * same Idempotency-Key does step 2 again, and the reconciliation job does it too (and fails the deposit with
 * provider_unavailable once its 30 minutes are over without a session). The deposit is completed only by the provider's
 * webhook or by the job, never here.
 */
export async function createDeposit(
  deps: PaymentsDeps,
  caller: TenantCaller,
  input: { idempotencyKey: unknown; amount: unknown },
): Promise<DepositResult> {
  checkIdempotencyKey(input.idempotencyKey);
  const key = input.idempotencyKey;
  const amount = guardDomain(() => parseAmount(input.amount));
  const hash = requestHash({ amount });

  const stored = await deps.store.tenantTransaction(caller.tenantId, async (repos): Promise<DepositResult> => {
    const replay = await replayOf(repos, caller, key, hash);
    if (replay) return { deposit: replay, created: false };

    const now = deps.clock.now();
    // The first look of the reconciliation job is a minute away: the request has that long to finish its own step 2 and 3.
    const fresh = guardDomain(() => {
      const made = newDeposit({ id: deps.ids.newId(), tenantId: caller.tenantId, userId: caller.userId, amount, idempotencyKey: key, requestHash: hash, now });
      return deferDepositCheck(made, addMs(now, reconcileDelayMs(0)), now);
    });
    if (!(await repos.deposits.insert(fresh))) {
      // Another request with the same key committed between the look above and the insert: answer with its deposit.
      const raced = await replayOf(repos, caller, key, hash);
      if (raced === null) throw new Unavailable("deposit_busy", "The deposit of this Idempotency-Key is not readable yet, try again", 1);
      return { deposit: raced, created: false };
    }
    return { deposit: fresh, created: true };
  });
  if (stored.deposit.status !== "pending" || stored.deposit.providerSessionId !== null) return stored;

  let session: ProviderCheckoutSession;
  try {
    session = await requestCheckoutSession(deps, caller.tenantId, stored.deposit);
  } catch (error) {
    throw providerFailure(error, deps.logger, "checkout session") ?? error;
  }
  return { deposit: await attachSession(deps, caller.tenantId, stored.deposit, session), created: stored.created };
}

/** Asks the provider for the deposit's checkout session; the deposit id is the Idempotency-Key. Holds no transaction. */
export function requestCheckoutSession(deps: PaymentsDeps, tenantId: string, deposit: Deposit): Promise<ProviderCheckoutSession> {
  return deps.provider.createCheckoutSession({
    depositId: deposit.id,
    tenantId,
    amount: deposit.amount,
    successUrl: deps.checkout.successUrl,
    cancelUrl: deps.checkout.cancelUrl,
  });
}

/**
 * Stores the session on the deposit in its own short transaction. A deposit that meanwhile got a session (the repeat of the
 * request, or the job) or was ended keeps what it has: the row as it is now is returned.
 */
export async function attachSession(deps: PaymentsDeps, tenantId: string, deposit: Deposit, session: ProviderCheckoutSession): Promise<Deposit> {
  return deps.store.tenantTransaction(tenantId, async (repos) => {
    const current = await repos.deposits.get(deposit.id, { forUpdate: true });
    if (current === null) return deposit;
    if (current.status !== "pending" || current.providerSessionId !== null) return current;
    const now = deps.clock.now();
    const attached = guardDomain(() => deferDepositCheck(attachCheckoutSession(current, session, now), addMs(now, reconcileDelayMs(current.checkAttempts)), now));
    await repos.deposits.save(attached);
    return attached;
  });
}

/** One deposit of the caller; another user's or another tenant's deposit does not exist as far as the caller can tell. */
export async function getDeposit(deps: UseCaseDeps, caller: TenantCaller, id: string): Promise<Deposit> {
  const deposit = await deps.store.tenantTransaction(caller.tenantId, (repos) => repos.deposits.get(id));
  if (deposit === null || deposit.userId !== caller.userId) throw new NotFound("deposit_not_found", "No such deposit");
  return deposit;
}

export type DepositSettlement = { to: "succeeded" } | { to: "failed"; reason: DepositFailureReason };

/** What a session state means for its deposit; an open session means nothing yet. */
export function depositSettlementFor(status: CheckoutSessionStatus): DepositSettlement | null {
  switch (status) {
    case "completed":
      return { to: "succeeded" };
    case "declined":
      return { to: "failed", reason: "declined" };
    case "expired":
      return { to: "failed", reason: "expired" };
    case "open":
      return null;
  }
}

/** Moves a pending deposit to its end state and writes the event in the same transaction (REL-01). */
export async function settleDeposit(
  repos: TenantRepositories,
  deps: Pick<UseCaseDeps, "ids">,
  deposit: Deposit,
  settlement: DepositSettlement,
  trigger: Caller,
  now: Date,
): Promise<Deposit> {
  const ctx = eventContext(deps, trigger, now);
  if (settlement.to === "succeeded") {
    const settled = guardDomain(() => succeedDeposit(deposit, now));
    await repos.deposits.save(settled);
    await repos.outbox.add(outboxMessage("DepositSucceeded", depositSucceededEvent(settled, now, ctx), settled.id, now));
    return settled;
  }
  const settled = guardDomain(() => failDeposit(deposit, settlement.reason, now));
  await repos.deposits.save(settled);
  await repos.outbox.add(outboxMessage("DepositFailed", depositFailedEvent(settled, settlement.reason, now, ctx), settled.id, now));
  return settled;
}
