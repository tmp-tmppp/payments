import { CONSUMED_EVENTS } from "../domain/events.js";
import { parseTenantCreated, parseWithdrawalRefunded } from "../domain/consumed-events.js";
import { markRefunded } from "../domain/withdrawal.js";
import { UnprocessableEvent, guardDomain } from "./errors.js";
import type { ConsumedEventHandler, UseCaseDeps } from "./ports.js";

// Handlers of the events this service consumes (ADR-053 inbox). Each one stores the processed event id in the same
// transaction as the change it causes, so a redelivery changes nothing. A handler throws to have the event delivered again
// (the tenant's schema is not there yet, the database is down) and throws UnprocessableEvent for what can never be handled.

/** The consumer names of the inbox: also the durable names on the broker. */
export const TENANT_CREATED_CONSUMER = "payments-tenant-created";
export const WITHDRAWAL_REFUNDED_CONSUMER = "payments-withdrawal-refunded";

/** TenantCreated: the tenant's schema is created and migrated, and the tenant registered, in one transaction with the inbox row. */
export function tenantCreatedHandler(deps: UseCaseDeps): ConsumedEventHandler {
  return async (event) => {
    if (event.type !== CONSUMED_EVENTS.tenantCreated.type) throw new UnprocessableEvent(`Unexpected event type ${event.type}`);
    const data = parseTenantCreated(event);
    if (data === null) throw new UnprocessableEvent("TenantCreated without a valid tenant id");
    await deps.store.transaction(async (repos) => {
      const now = deps.clock.now();
      if (!(await repos.inbox.markProcessed(TENANT_CREATED_CONSUMER, { id: event.id, type: event.type }, now))) return;
      await repos.tenants.provision(data.tenantId, now);
      deps.logger.info({ tenantId: data.tenantId, eventId: event.id }, "A tenant schema is ready");
    });
  };
}

/**
 * WithdrawalRefunded (a proposal of the trading owner): trading gave the credits of a failed withdrawal back, and the saga
 * ends. An event that does not fit (an unknown withdrawal, another user or amount, a withdrawal that did not fail) is
 * logged and dropped, never redelivered: it cannot become right by waiting. A tenant whose schema is not there yet is
 * redelivered (TenantNotReady).
 */
export function withdrawalRefundedHandler(deps: UseCaseDeps): ConsumedEventHandler {
  return async (event) => {
    if (event.type !== CONSUMED_EVENTS.withdrawalRefunded.type) throw new UnprocessableEvent(`Unexpected event type ${event.type}`);
    const data = parseWithdrawalRefunded(event);
    if (data === null) throw new UnprocessableEvent("WithdrawalRefunded without a valid withdrawal id, user id and amount");
    await deps.store.tenantTransaction(event.tenantId, async (repos) => {
      const now = deps.clock.now();
      if (!(await repos.inbox.markProcessed(WITHDRAWAL_REFUNDED_CONSUMER, { id: event.id, type: event.type }, now))) return;
      const withdrawal = await repos.withdrawals.get(data.withdrawalId, { forUpdate: true });
      if (withdrawal === null || withdrawal.userId !== data.userId || withdrawal.amount !== data.amount || withdrawal.status !== "failed") {
        deps.logger.warn(
          { eventId: event.id, withdrawalId: data.withdrawalId, status: withdrawal?.status ?? "unknown" },
          "A WithdrawalRefunded does not fit a failed withdrawal: dropped",
        );
        return;
      }
      await repos.withdrawals.save(guardDomain(() => markRefunded(withdrawal, now)));
    });
  };
}
