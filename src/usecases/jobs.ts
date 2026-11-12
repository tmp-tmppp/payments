import { deferDepositCheck, isDepositExpired, recordDepositCheck } from "../domain/deposit.js";
import type { Deposit } from "../domain/deposit.js";
import { attachPayout, deferDebit, deferPayout, markPayoutRequested, recordPayoutAttempt } from "../domain/withdrawal.js";
import type { Withdrawal } from "../domain/withdrawal.js";
import { attachSession, depositSettlementFor, reconcileDelayMs, requestCheckoutSession, settleDeposit } from "./deposits.js";
import type { DepositSettlement } from "./deposits.js";
import { PaymentProviderRejected, PaymentProviderUnavailable, guardDomain } from "./errors.js";
import type { Caller, PaymentsDeps, ProviderPayout, TenantRepositories } from "./ports.js";
import { addMs, backoffMs } from "./support.js";
import { PAYOUT_POLL_MS, applyDebitOutcome, settleWithdrawal, withdrawalSettlementFor } from "./withdrawals.js";
import type { WithdrawalSettlement } from "./withdrawals.js";

// The background jobs of the saga. They are plain functions over the ports; the loop that calls them is
// src/adapters/jobs/job-runner.ts. Two replicas never act on the same row twice: a job first CLAIMS the due rows in a short
// transaction (the repositories lock them with FOR UPDATE SKIP LOCKED) and pushes their next time forward (a lease), commits,
// then calls the provider or trading with no transaction and no lock held, and finally changes the row in a second
// transaction that reads it again FOR UPDATE and does nothing when another path got there first. A worker that dies
// in the middle leaves a row that comes due again when its lease ends; every call it repeats is idempotent by id.

export const DEPOSIT_LEASE_MS = 120_000;
export const DEBIT_LEASE_MS = 60_000;
export const PAYOUT_LEASE_MS = 120_000;
/**
 * From this many payout steps without a result on, every further try logs an error: somebody should look. The job never gives
 * up creating a payout: a create call that got no answer may have reached the provider, which then pays it even if the
 * withdrawal were failed and the credits refunded (the user would be paid twice). Every repeat is safe (same Idempotency-Key).
 */
export const PAYOUT_ALERT_ATTEMPTS = 60;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 300_000;

export interface JobCounts {
  deposits: number;
  debits: number;
  payouts: number;
}

const systemCaller = (job: string, id: string): Caller => ({ userId: "system", correlationId: `${job}:${id}`, causationId: job });
const unreachable = (error: unknown): boolean => error instanceof PaymentProviderUnavailable || error instanceof PaymentProviderRejected;
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Runs `work` for every tenant that has a schema; a failing tenant is logged and does not stop the others. */
async function forEachTenant(deps: PaymentsDeps, work: (tenantId: string) => Promise<number>): Promise<number> {
  let total = 0;
  for (const tenantId of await deps.store.repositories.tenants.list()) {
    try {
      total += await work(tenantId);
    } catch (error) {
      deps.logger.error({ err: error, tenantId }, "A background job failed for a tenant");
    }
  }
  return total;
}

async function each<T>(deps: PaymentsDeps, rows: readonly T[], what: string, work: (row: T) => Promise<void>): Promise<void> {
  for (const row of rows) {
    try {
      await work(row);
    } catch (error) {
      // The row keeps its lease and comes due again when it ends.
      deps.logger.error({ err: error, what }, "A background step failed; it is repeated when its lease ends");
    }
  }
}

// ---- Deposits: reconcile pending checkout sessions and expire the ones nobody paid ----

/**
 * Looks at every pending deposit that is due by reading its checkout session back: completed -> succeeded (completed wins,
 * always), declined or expired -> failed, a session the provider forgot (404) -> failed "expired". An open session keeps the
 * deposit pending, whatever payments' own clock says (the provider decides when a session ends; it reads as expired once its
 * lifetime is over): it is looked at again after 1, 2, 5, 10, then every 20 minutes, and right after the session's own end
 * when that comes sooner (this covers a lost webhook). A pending deposit that has no session yet (the request that made it
 * could not reach the provider) gets its session created now (same Idempotency-Key), and fails with provider_unavailable once
 * its 30 minutes are over without one. A provider that does not answer leaves the deposit pending and is asked again later.
 */
export async function checkDeposits(deps: PaymentsDeps, batchSize: number): Promise<number> {
  return forEachTenant(deps, async (tenantId) => {
    const now = deps.clock.now();
    const claimed = await deps.store.tenantTransaction(tenantId, async (repos) => {
      const due = await repos.deposits.claimDue(now, batchSize);
      for (const deposit of due) await repos.deposits.save(guardDomain(() => deferDepositCheck(deposit, addMs(now, DEPOSIT_LEASE_MS), now)));
      return due;
    });
    await each(deps, claimed, "deposit check", (deposit) => checkDeposit(deps, tenantId, deposit));
    return claimed.length;
  });
}

async function checkDeposit(deps: PaymentsDeps, tenantId: string, deposit: Deposit): Promise<void> {
  let observed: DepositSettlement | null;
  let sessionEnd: Date | null = null;
  try {
    if (deposit.providerSessionId === null) {
      await startSession(deps, tenantId, deposit);
      return;
    }
    const session = await deps.provider.getCheckoutSession(deposit.providerSessionId);
    // A session the provider no longer knows can never be paid: it counts as expired.
    observed = session === null ? { to: "failed", reason: "expired" } : depositSettlementFor(session.status);
    sessionEnd = session?.expiresAt ?? null;
  } catch (error) {
    if (!unreachable(error)) throw error;
    const now = deps.clock.now();
    deps.logger.warn({ err: error, depositId: deposit.id }, "The payment provider did not answer a deposit check");
    await deps.store.tenantTransaction(tenantId, async (repos) => {
      const current = await repos.deposits.get(deposit.id, { forUpdate: true });
      if (current === null || current.status !== "pending") return;
      const next = { at: addMs(now, backoffMs(current.checkAttempts, RETRY_BASE_MS, RETRY_MAX_MS)), error: describe(error) };
      await repos.deposits.save(guardDomain(() => recordDepositCheck(current, next, now)));
    });
    return;
  }

  await deps.store.tenantTransaction(tenantId, async (repos) => {
    const now = deps.clock.now();
    const current = await repos.deposits.get(deposit.id, { forUpdate: true });
    if (current === null || current.status !== "pending") return;
    if (observed === null) {
      // The session is open: the provider decides when it ends. Look again with a growing wait, but right after its own end when sooner.
      let at = addMs(now, reconcileDelayMs(current.checkAttempts + 1));
      if (sessionEnd !== null && sessionEnd.getTime() > now.getTime()) at = new Date(Math.min(at.getTime(), sessionEnd.getTime() + 1000));
      await repos.deposits.save(guardDomain(() => recordDepositCheck(current, { at, error: null }, now)));
      return;
    }
    await settleDeposit(repos, deps, current, observed, systemCaller("deposit-check", current.id), now);
  });
}

/** A pending deposit with no checkout session: create it now, or fail the deposit when its 30 minutes are over. Provider errors go to the caller's back-off. */
async function startSession(deps: PaymentsDeps, tenantId: string, deposit: Deposit): Promise<void> {
  if (isDepositExpired(deposit, deps.clock.now())) {
    deps.logger.error({ depositId: deposit.id }, "A deposit never got a checkout session in 30 minutes: it fails");
    await deps.store.tenantTransaction(tenantId, async (repos) => {
      const current = await repos.deposits.get(deposit.id, { forUpdate: true });
      if (current === null || current.status !== "pending" || current.providerSessionId !== null) return;
      await settleDeposit(repos, deps, current, { to: "failed", reason: "provider_unavailable" }, systemCaller("deposit-check", current.id), deps.clock.now());
    });
    return;
  }
  const session = await requestCheckoutSession(deps, tenantId, deposit);
  await attachSession(deps, tenantId, deposit, session);
}

// ---- Withdrawals: repeat debits whose outcome is unknown ----

/** Repeats the debit (same withdrawal id, so trading never takes the credits twice) of every requested withdrawal that is due. */
export async function retryDebits(deps: PaymentsDeps, batchSize: number): Promise<number> {
  return forEachTenant(deps, async (tenantId) => {
    const now = deps.clock.now();
    const claimed = await deps.store.tenantTransaction(tenantId, async (repos) => {
      const due = await repos.withdrawals.claimDebitDue(now, batchSize);
      for (const withdrawal of due) await repos.withdrawals.save(guardDomain(() => deferDebit(withdrawal, addMs(now, DEBIT_LEASE_MS), now)));
      return due;
    });
    await each(deps, claimed, "debit retry", async (withdrawal) => {
      const outcome = await deps.trading.debit({
        withdrawalId: withdrawal.id,
        tenantId,
        userId: withdrawal.userId,
        amount: withdrawal.amount,
        correlationId: systemCaller("debit-retry", withdrawal.id).correlationId,
      });
      await deps.store.tenantTransaction(tenantId, async (repos) => {
        const current = await repos.withdrawals.get(withdrawal.id, { forUpdate: true });
        if (current === null) return;
        const after = await applyDebitOutcome(repos, current, outcome, "job", deps.clock.now());
        deps.logger.info({ withdrawalId: withdrawal.id, outcome: outcome.kind, status: after.status, attempts: after.debitAttempts }, "A debit was repeated");
      });
    });
    return claimed.length;
  });
}

// ---- Withdrawals: send payouts and read pending ones back ----

/**
 * Takes every debited withdrawal whose payout step is due. Without a payout yet and with no create ever sent: the
 * force-payout-failure flag is looked at first and, when on, the payout is declined right there in the claim transaction and
 * the provider is never called (reason "forced"). Otherwise the claim transaction records that a create is about to be sent
 * (`payoutRequestedAt`, so the flag never applies to this withdrawal again), and the payout is created after the commit (the
 * withdrawal id is the Idempotency-Key, so a repeat after a lost answer returns the same payout). With a payout: it is read
 * back; paid -> paid_out, failed -> failed "declined", unknown to the provider (404) -> failed "payout_lost", still pending ->
 * looked at again in a few seconds. The webhook does the same work sooner when it arrives.
 */
export async function sendPayouts(deps: PaymentsDeps, batchSize: number): Promise<number> {
  return forEachTenant(deps, async (tenantId) => {
    const now = deps.clock.now();
    const claim = await deps.store.tenantTransaction(tenantId, async (repos) => {
      const due = await repos.withdrawals.claimPayoutDue(now, batchSize);
      const work: Withdrawal[] = [];
      for (const withdrawal of due) {
        if (withdrawal.providerPayoutId === null && withdrawal.payoutRequestedAt === null && deps.settings.forcePayoutFailure()) {
          deps.logger.warn({ withdrawalId: withdrawal.id }, "The force-payout-failure flag is on: the payout is declined without calling the provider");
          await settleWithdrawal(repos, deps, withdrawal, { to: "failed", reason: "forced" }, systemCaller("payout", withdrawal.id), now);
          continue;
        }
        const until = addMs(now, PAYOUT_LEASE_MS);
        const leased = guardDomain(() => (withdrawal.providerPayoutId === null ? markPayoutRequested(withdrawal, until, now) : deferPayout(withdrawal, until, now)));
        await repos.withdrawals.save(leased);
        work.push(leased);
      }
      return { due: due.length, work };
    });
    await each(deps, claim.work, "payout", (withdrawal) => processPayout(deps, tenantId, withdrawal));
    return claim.due;
  });
}

async function processPayout(deps: PaymentsDeps, tenantId: string, withdrawal: Withdrawal): Promise<void> {
  const trigger = systemCaller("payout", withdrawal.id);

  /** Runs `work` on the withdrawal as it is now, if it is still debited (the webhook may have settled it meanwhile). */
  const current = (work: (repos: TenantRepositories, row: Withdrawal, now: Date) => Promise<void>): Promise<void> =>
    deps.store.tenantTransaction(tenantId, async (repos) => {
      const row = await repos.withdrawals.get(withdrawal.id, { forUpdate: true });
      if (row === null || row.status !== "debited") return;
      await work(repos, row, deps.clock.now());
    });
  const settle = (settlement: WithdrawalSettlement): Promise<void> => current(async (repos, row, now) => void (await settleWithdrawal(repos, deps, row, settlement, trigger, now)));
  const applyPayout = async (repos: TenantRepositories, row: Withdrawal, payout: ProviderPayout, now: Date): Promise<void> => {
    const settlement = withdrawalSettlementFor(payout.status);
    if (settlement === null) await repos.withdrawals.save(guardDomain(() => deferPayout(row, addMs(now, PAYOUT_POLL_MS), now)));
    else await settleWithdrawal(repos, deps, row, settlement, trigger, now);
  };
  const retryLater = (error: unknown): Promise<void> =>
    current(async (repos, row, now) => {
      // Never given up: the next try repeats the same call (same Idempotency-Key). From many tries on an error line asks for a look.
      if (row.payoutAttempts + 1 >= PAYOUT_ALERT_ATTEMPTS) {
        deps.logger.error({ withdrawalId: row.id, attempts: row.payoutAttempts + 1 }, "The payout step keeps failing: the credits stay debited and the job keeps trying; this needs a look");
      }
      const next = { at: addMs(now, backoffMs(row.payoutAttempts, RETRY_BASE_MS, RETRY_MAX_MS)), error: describe(error) };
      await repos.withdrawals.save(guardDomain(() => recordPayoutAttempt(row, next, now)));
    });

  if (withdrawal.providerPayoutId === null) {
    let payout: ProviderPayout;
    try {
      payout = await deps.provider.createPayout({ withdrawalId: withdrawal.id, tenantId, userId: withdrawal.userId, amount: withdrawal.amount });
    } catch (error) {
      if (error instanceof PaymentProviderRejected) {
        // A 4xx: the provider refuses this payout for good, repeating it does not help.
        deps.logger.error({ err: error, withdrawalId: withdrawal.id, status: error.status }, "The payment provider refused the payout");
        await settle({ to: "failed", reason: "declined" });
        return;
      }
      if (error instanceof PaymentProviderUnavailable) {
        deps.logger.warn({ err: error, withdrawalId: withdrawal.id }, "The payment provider did not take the payout yet");
        await retryLater(error);
        return;
      }
      throw error;
    }
    await current(async (repos, row, now) => {
      await applyPayout(repos, guardDomain(() => attachPayout(row, payout.id, now)), payout, now);
    });
    return;
  }

  let payout: ProviderPayout | null;
  try {
    payout = await deps.provider.getPayout(withdrawal.providerPayoutId);
  } catch (error) {
    if (!unreachable(error)) throw error;
    // The payout exists at the provider: never give up on reading it, only wait.
    deps.logger.warn({ err: error, withdrawalId: withdrawal.id }, "The payment provider did not answer a payout check");
    await retryLater(error);
    return;
  }
  if (payout === null) {
    deps.logger.error({ withdrawalId: withdrawal.id, payoutId: withdrawal.providerPayoutId }, "The provider no longer knows the payout: it is lost and counts as failed");
    await settle({ to: "failed", reason: "payout_lost" });
    return;
  }
  const known = payout;
  await current((repos, row, now) => applyPayout(repos, row, known, now));
}

/** One pass of every job. A count at the batch size means there may be more waiting. */
export async function runDueWork(deps: PaymentsDeps, batchSize: number): Promise<JobCounts> {
  const deposits = await checkDeposits(deps, batchSize);
  const debits = await retryDebits(deps, batchSize);
  const payouts = await sendPayouts(deps, batchSize);
  return { deposits, debits, payouts };
}
