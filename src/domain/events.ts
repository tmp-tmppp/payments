import type { DepositFailureReason } from "./deposit.js";
import type { WithdrawalFailureReason } from "./withdrawal.js";

// Integration events as CloudEvents 1.0 (structured JSON). The shape is the contract in contracts/asyncapi.yaml.
// Events carry ids and amounts, never names or e-mails (DM-14). An amount is credits = EUR cents.
export const EVENT_SOURCE = "/chance/payments";
export const SUBJECT_PREFIX = "chance.payments";

/** The events this service publishes, on the stream PAYMENTS. */
export type EventName = "DepositSucceeded" | "DepositFailed" | "WithdrawalSucceeded" | "WithdrawalFailed";

/** The events this service consumes: TenantCreated (stream TENANTS) and WithdrawalRefunded (stream TRADING, a proposal). */
export const CONSUMED_EVENTS = {
  tenantCreated: {
    stream: "TENANTS",
    subjectPrefix: "chance.tenants.TenantCreated",
    type: "si.chance.tenants.TenantCreated.v1",
  },
  withdrawalRefunded: {
    stream: "TRADING",
    subjectPrefix: "chance.trading.WithdrawalRefunded",
    type: "si.chance.trading.WithdrawalRefunded.v1",
  },
} as const;

export interface CloudEvent<TData> {
  specversion: "1.0";
  id: string;
  source: typeof EVENT_SOURCE;
  type: string;
  subject: string;
  time: string;
  datacontenttype: "application/json";
  tenantid: string;
  correlationid: string;
  causationid: string;
  data: TData;
}

/** What the use case knows about the event it is writing. */
export interface EventContext {
  eventId: string;
  now: Date;
  correlationId: string;
  causationId: string;
}

export interface DepositSucceededData {
  depositId: string;
  tenantId: string;
  userId: string;
  amount: number;
  succeededAt: string;
}

export interface DepositFailedData {
  depositId: string;
  tenantId: string;
  userId: string;
  amount: number;
  reason: DepositFailureReason;
  failedAt: string;
}

export interface WithdrawalSucceededData {
  withdrawalId: string;
  tenantId: string;
  userId: string;
  amount: number;
  paidOutAt: string;
}

export interface WithdrawalFailedData {
  withdrawalId: string;
  tenantId: string;
  userId: string;
  amount: number;
  reason: WithdrawalFailureReason;
  failedAt: string;
}

/** The consumed TenantCreated of the tenants service: payments needs the id, and ignores the rest. */
export interface TenantCreatedData {
  tenantId: string;
  name?: string;
  slug?: string;
  createdAt?: string;
}

/** The consumed WithdrawalRefunded of trading (a proposal): the credits of a failed withdrawal went back to the user. */
export interface WithdrawalRefundedData {
  withdrawalId: string;
  userId: string;
  amount: number;
}

export function eventType(name: EventName): string {
  return `si.chance.payments.${name}.v1`;
}

/** NATS subject of an event: chance.payments.<Event>.<tenantId>. */
export function natsSubject(name: EventName, tenantId: string): string {
  return `${SUBJECT_PREFIX}.${name}.${tenantId}`;
}

function envelope<TData>(
  name: EventName,
  subject: string,
  tenantId: string,
  ctx: EventContext,
  data: TData,
): CloudEvent<TData> {
  return {
    specversion: "1.0",
    id: ctx.eventId,
    source: EVENT_SOURCE,
    type: eventType(name),
    subject,
    time: ctx.now.toISOString(),
    datacontenttype: "application/json",
    tenantid: tenantId,
    correlationid: ctx.correlationId,
    causationid: ctx.causationId,
    data,
  };
}

export function depositSucceededEvent(
  deposit: { id: string; tenantId: string; userId: string; amount: number },
  succeededAt: Date,
  ctx: EventContext,
): CloudEvent<DepositSucceededData> {
  return envelope("DepositSucceeded", `deposit/${deposit.id}`, deposit.tenantId, ctx, {
    depositId: deposit.id,
    tenantId: deposit.tenantId,
    userId: deposit.userId,
    amount: deposit.amount,
    succeededAt: succeededAt.toISOString(),
  });
}

export function depositFailedEvent(
  deposit: { id: string; tenantId: string; userId: string; amount: number },
  reason: DepositFailureReason,
  failedAt: Date,
  ctx: EventContext,
): CloudEvent<DepositFailedData> {
  return envelope("DepositFailed", `deposit/${deposit.id}`, deposit.tenantId, ctx, {
    depositId: deposit.id,
    tenantId: deposit.tenantId,
    userId: deposit.userId,
    amount: deposit.amount,
    reason,
    failedAt: failedAt.toISOString(),
  });
}

export function withdrawalSucceededEvent(
  withdrawal: { id: string; tenantId: string; userId: string; amount: number },
  paidOutAt: Date,
  ctx: EventContext,
): CloudEvent<WithdrawalSucceededData> {
  return envelope("WithdrawalSucceeded", `withdrawal/${withdrawal.id}`, withdrawal.tenantId, ctx, {
    withdrawalId: withdrawal.id,
    tenantId: withdrawal.tenantId,
    userId: withdrawal.userId,
    amount: withdrawal.amount,
    paidOutAt: paidOutAt.toISOString(),
  });
}

export function withdrawalFailedEvent(
  withdrawal: { id: string; tenantId: string; userId: string; amount: number },
  reason: WithdrawalFailureReason,
  failedAt: Date,
  ctx: EventContext,
): CloudEvent<WithdrawalFailedData> {
  return envelope("WithdrawalFailed", `withdrawal/${withdrawal.id}`, withdrawal.tenantId, ctx, {
    withdrawalId: withdrawal.id,
    tenantId: withdrawal.tenantId,
    userId: withdrawal.userId,
    amount: withdrawal.amount,
    reason,
    failedAt: failedAt.toISOString(),
  });
}
