import type { Deposit } from "../domain/deposit.js";
import type { Withdrawal } from "../domain/withdrawal.js";
import { createDeposit, getDeposit } from "./deposits.js";
import type { DepositResult } from "./deposits.js";
import type { PaymentsDeps } from "./ports.js";
import { handleProviderEvent } from "./provider-events.js";
import type { ProviderEventInput, WebhookResult } from "./provider-events.js";
import type { TenantCaller } from "./support.js";
import { getWithdrawal, requestWithdrawal } from "./withdrawals.js";
import type { WithdrawalResult } from "./withdrawals.js";

/** What the web layer calls. It knows nothing of ports, repositories or the provider (GP-6.28). */
export interface UseCases {
  createDeposit(caller: TenantCaller, input: { idempotencyKey: unknown; amount: unknown }): Promise<DepositResult>;
  getDeposit(caller: TenantCaller, id: string): Promise<Deposit>;
  createWithdrawal(caller: TenantCaller, input: { idempotencyKey: unknown; amount: unknown }): Promise<WithdrawalResult>;
  getWithdrawal(caller: TenantCaller, id: string): Promise<Withdrawal>;
  handleProviderEvent(event: ProviderEventInput): Promise<WebhookResult>;
}

export function createUseCases(deps: PaymentsDeps): UseCases {
  return {
    createDeposit: (caller, input) => createDeposit(deps, caller, input),
    getDeposit: (caller, id) => getDeposit(deps, caller, id),
    createWithdrawal: (caller, input) => requestWithdrawal(deps, caller, input),
    getWithdrawal: (caller, id) => getWithdrawal(deps, caller, id),
    handleProviderEvent: (event) => handleProviderEvent(deps, event),
  };
}
