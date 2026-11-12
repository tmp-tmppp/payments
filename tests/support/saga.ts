import { createDeposit } from "../../src/usecases/deposits.js";
import { sendPayouts } from "../../src/usecases/jobs.js";
import { requestWithdrawal } from "../../src/usecases/withdrawals.js";
import { TENANT_A, TENANT_B, createCore, provisionTenants, who } from "./harness.js";

/** The core with two tenants that have a schema, and readers of what the store holds. */
export async function setupSaga() {
  const core = createCore();
  await provisionTenants(core, TENANT_A, TENANT_B);
  const deposits = (tenantId = TENANT_A) => core.store.snapshot().tenants.get(tenantId)?.deposits ?? [];
  const withdrawals = (tenantId = TENANT_A) => core.store.snapshot().tenants.get(tenantId)?.withdrawals ?? [];
  const outbox = () => core.store.snapshot().outbox;
  const inbox = () => core.store.snapshot().inbox;
  const providerEvents = () => core.store.snapshot().providerEvents;
  return { ...core, deposits, withdrawals, outbox, inbox, providerEvents };
}

export type Saga = Awaited<ReturnType<typeof setupSaga>>;

let counter = 0;
const nextKey = (): string => {
  counter += 1;
  return `key-${counter}`;
};

/** A pending deposit with its checkout session. */
export async function pendingDeposit(saga: Saga, amount = 2500, userId = "user-1", tenantId = TENANT_A) {
  const { deposit } = await createDeposit(saga.deps, who(userId, tenantId), { idempotencyKey: nextKey(), amount });
  return deposit;
}

/** A debited withdrawal. */
export async function debitedWithdrawal(saga: Saga, amount = 1800, userId = "user-1", tenantId = TENANT_A) {
  const { withdrawal } = await requestWithdrawal(saga.deps, who(userId, tenantId), { idempotencyKey: nextKey(), amount });
  return withdrawal;
}

/** A debited withdrawal whose payout the job has created at the provider (still pending there). */
export async function withdrawalWithPayout(saga: Saga, amount = 1800, userId = "user-1", tenantId = TENANT_A) {
  const withdrawal = await debitedWithdrawal(saga, amount, userId, tenantId);
  await sendPayouts(saga.deps, 10);
  const payout = saga.provider.payoutList().find((candidate) => candidate.metadata["withdrawalId"] === withdrawal.id);
  if (!payout) throw new Error("the payout was not created");
  return { withdrawal, payout };
}
