import { isUuid } from "../domain/consumed-events.js";
import { attachPayout } from "../domain/withdrawal.js";
import type { Withdrawal } from "../domain/withdrawal.js";
import { depositSettlementFor, settleDeposit } from "./deposits.js";
import { guardDomain } from "./errors.js";
import type { Caller, PaymentsDeps, ProviderCheckoutSession, ProviderPayout } from "./ports.js";
import { providerFailure } from "./support.js";
import { settleWithdrawal, withdrawalSettlementFor } from "./withdrawals.js";

// The webhook of the payment provider (plan FL-B step 3, FL-C step 5). The event is thin and only a hint: the signature has
// been checked by the caller, and here the object is read back from the provider and the state it has now decides. The ids
// in its metadata name our deposit or withdrawal, and are trusted only after both checks. The provider id of the event is
// stored in the same transaction as the change, so a repeat changes nothing.

export interface ProviderEventInput {
  /** The provider's event id: the same for every attempt to deliver the event. */
  id: string;
  type: string;
  objectKind: "checkout_session" | "payout";
  objectId: string;
  correlationId: string;
}

/** processed: something changed. duplicate: the event id was seen before. ignored: nothing to change (unknown object, a state that means nothing yet, a stale one). */
export type WebhookResult = "processed" | "duplicate" | "ignored";

interface Target {
  tenantId: string;
  resourceId: string;
}

function targetOf(metadata: Readonly<Record<string, string>>, key: "depositId" | "withdrawalId"): Target | null {
  const tenantId = metadata["tenantId"];
  const resourceId = metadata[key];
  if (!isUuid(tenantId) || !isUuid(resourceId)) return null;
  return { tenantId: tenantId.toLowerCase(), resourceId: resourceId.toLowerCase() };
}

export async function handleProviderEvent(deps: PaymentsDeps, event: ProviderEventInput): Promise<WebhookResult> {
  const trigger: Caller = { userId: "payment-provider", correlationId: event.correlationId, causationId: event.id };
  const received = { id: event.id, type: event.type, objectId: event.objectId };

  // The read back comes before any change: a provider that does not answer leaves nothing recorded, so its retry is handled.
  let object: ProviderCheckoutSession | ProviderPayout | null;
  try {
    object = event.objectKind === "checkout_session" ? await deps.provider.getCheckoutSession(event.objectId) : await deps.provider.getPayout(event.objectId);
  } catch (error) {
    throw providerFailure(error, deps.logger, "read back for a webhook") ?? error;
  }

  const target = object === null ? null : targetOf(object.metadata, event.objectKind === "checkout_session" ? "depositId" : "withdrawalId");
  if (object === null || target === null) {
    deps.logger.warn({ eventId: event.id, objectKind: event.objectKind, objectId: event.objectId, known: object !== null }, "A webhook names an object this service does not know");
    const fresh = await deps.store.transaction((repos) => repos.providerEvents.markReceived(received, deps.clock.now()));
    return fresh ? "ignored" : "duplicate";
  }

  return deps.store.tenantTransaction(target.tenantId, async (repos): Promise<WebhookResult> => {
    const now = deps.clock.now();
    if (!(await repos.providerEvents.markReceived(received, now))) return "duplicate";

    if (event.objectKind === "checkout_session") {
      const session = object as ProviderCheckoutSession;
      const deposit = await repos.deposits.get(target.resourceId, { forUpdate: true });
      if (deposit === null || deposit.providerSessionId !== session.id || deposit.amount !== session.amount) {
        deps.logger.error({ eventId: event.id, depositId: target.resourceId }, "A checkout session does not match the deposit it names");
        return "ignored";
      }
      const settlement = depositSettlementFor(session.status);
      if (settlement === null) return "ignored";
      if (deposit.status !== "pending") {
        if (settlement.to === "succeeded" && deposit.status === "failed") {
          deps.logger.error({ eventId: event.id, depositId: deposit.id, reason: deposit.failureReason }, "A deposit that failed was paid after all: it needs a manual decision");
        }
        return "ignored";
      }
      await settleDeposit(repos, deps, deposit, settlement, trigger, now);
      return "processed";
    }

    const payout = object as ProviderPayout;
    const withdrawal = await repos.withdrawals.get(target.resourceId, { forUpdate: true });
    if (
      withdrawal === null ||
      payout.amount !== withdrawal.amount ||
      payout.destination !== withdrawal.userId ||
      (withdrawal.providerPayoutId !== null && withdrawal.providerPayoutId !== payout.id)
    ) {
      deps.logger.error({ eventId: event.id, withdrawalId: target.resourceId }, "A payout does not match the withdrawal it names");
      return "ignored";
    }
    const settlement = withdrawalSettlementFor(payout.status);
    if (settlement === null) return "ignored";
    if (withdrawal.status !== "debited") {
      if (settlement.to === "paid_out" && (withdrawal.status === "failed" || withdrawal.status === "refunded")) {
        deps.logger.error({ eventId: event.id, withdrawalId: withdrawal.id, status: withdrawal.status, reason: withdrawal.reason }, "A payout was paid for a withdrawal that failed: the user may be paid twice, it needs a manual decision");
      }
      return "ignored";
    }
    // The job may have created the payout without saving its id (a crash in between): the metadata and the read back tie it to this withdrawal.
    const known: Withdrawal = withdrawal.providerPayoutId === null ? guardDomain(() => attachPayout(withdrawal, payout.id, now)) : withdrawal;
    await settleWithdrawal(repos, deps, known, settlement, trigger, now);
    return "processed";
  });
}
