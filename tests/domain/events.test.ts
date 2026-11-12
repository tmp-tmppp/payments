import { describe, expect, it } from "vitest";
import {
  CONSUMED_EVENTS,
  EVENT_SOURCE,
  depositFailedEvent,
  depositSucceededEvent,
  eventType,
  natsSubject,
  withdrawalFailedEvent,
  withdrawalSucceededEvent,
} from "../../src/domain/events.js";
import type { EventContext, EventName } from "../../src/domain/events.js";
import { asyncapi, eventErrors } from "../support/contracts.js";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const ctx: EventContext = { eventId: "018f3c1e-7a00-7000-8000-000000000001", now: NOW, correlationId: "corr-1", causationId: "req-1" };
const tenantId = "018f3c1e-7a00-7000-8000-0000000000aa";
const deposit = { id: "018f3c1e-7a00-7000-8000-0000000000d1", tenantId, userId: "user-1", amount: 2500 };
const withdrawal = { id: "018f3c1e-7a00-7000-8000-0000000000e1", tenantId, userId: "user-1", amount: 1800 };

describe("event names", () => {
  it("builds the type and the NATS subject the contract names", () => {
    expect(EVENT_SOURCE).toBe("/chance/payments");
    expect(eventType("DepositSucceeded")).toBe("si.chance.payments.DepositSucceeded.v1");
    expect(natsSubject("WithdrawalFailed", tenantId)).toBe(`chance.payments.WithdrawalFailed.${tenantId}`);
  });

  it("names the consumed events as the contract and the proposal do", () => {
    expect(CONSUMED_EVENTS.tenantCreated).toEqual({ stream: "TENANTS", subjectPrefix: "chance.tenants.TenantCreated", type: "si.chance.tenants.TenantCreated.v1" });
    expect(CONSUMED_EVENTS.withdrawalRefunded).toEqual({
      stream: "TRADING",
      subjectPrefix: "chance.trading.WithdrawalRefunded",
      type: "si.chance.trading.WithdrawalRefunded.v1",
    });
  });
});

describe("event builders", () => {
  it("DepositSucceeded: envelope, ids and the amount, nothing else", () => {
    const event = depositSucceededEvent(deposit, NOW, ctx);
    expect(event).toEqual({
      specversion: "1.0",
      id: ctx.eventId,
      source: "/chance/payments",
      type: "si.chance.payments.DepositSucceeded.v1",
      subject: `deposit/${deposit.id}`,
      time: "2026-11-01T10:00:00.000Z",
      datacontenttype: "application/json",
      tenantid: tenantId,
      correlationid: "corr-1",
      causationid: "req-1",
      data: { depositId: deposit.id, tenantId, userId: "user-1", amount: 2500, succeededAt: "2026-11-01T10:00:00.000Z" },
    });
  });

  it("DepositFailed carries the reason", () => {
    const event = depositFailedEvent(deposit, "expired", NOW, ctx);
    expect(event).toMatchObject({ type: "si.chance.payments.DepositFailed.v1", subject: `deposit/${deposit.id}` });
    expect(event.data).toEqual({ depositId: deposit.id, tenantId, userId: "user-1", amount: 2500, reason: "expired", failedAt: "2026-11-01T10:00:00.000Z" });
  });

  it("WithdrawalSucceeded", () => {
    const event = withdrawalSucceededEvent(withdrawal, NOW, ctx);
    expect(event).toMatchObject({ type: "si.chance.payments.WithdrawalSucceeded.v1", subject: `withdrawal/${withdrawal.id}`, tenantid: tenantId });
    expect(event.data).toEqual({ withdrawalId: withdrawal.id, tenantId, userId: "user-1", amount: 1800, paidOutAt: "2026-11-01T10:00:00.000Z" });
  });

  it("WithdrawalFailed carries what trading needs to refund: withdrawal id, user and amount", () => {
    const event = withdrawalFailedEvent(withdrawal, "forced", NOW, ctx);
    expect(event).toMatchObject({ type: "si.chance.payments.WithdrawalFailed.v1", subject: `withdrawal/${withdrawal.id}` });
    expect(event.data).toEqual({ withdrawalId: withdrawal.id, tenantId, userId: "user-1", amount: 1800, reason: "forced", failedAt: "2026-11-01T10:00:00.000Z" });
  });

  it("never puts a name or an e-mail into the data", () => {
    const events = [
      depositSucceededEvent(deposit, NOW, ctx),
      depositFailedEvent(deposit, "declined", NOW, ctx),
      withdrawalSucceededEvent(withdrawal, NOW, ctx),
      withdrawalFailedEvent(withdrawal, "payout_lost", NOW, ctx),
    ];
    for (const event of events) {
      expect(Object.keys(event.data).sort()).not.toEqual(expect.arrayContaining(["email", "name"]));
      expect(JSON.stringify(event.data)).not.toMatch(/@/);
    }
  });
});

describe("the builders against contracts/asyncapi.yaml", () => {
  const cases: Array<[EventName, string, unknown]> = [
    ["DepositSucceeded", "DepositSucceededEvent", depositSucceededEvent(deposit, NOW, ctx)],
    ["DepositFailed", "DepositFailedEvent", depositFailedEvent(deposit, "declined", NOW, ctx)],
    ["WithdrawalSucceeded", "WithdrawalSucceededEvent", withdrawalSucceededEvent(withdrawal, NOW, ctx)],
    ["WithdrawalFailed", "WithdrawalFailedEvent", withdrawalFailedEvent(withdrawal, "payout_lost", NOW, ctx)],
  ];

  it.each(cases)("%s is accepted by the schema %s", (_name, schema, event) => {
    expect(eventErrors(schema, event)).toEqual([]);
  });

  it("rejects an event that breaks the contract", () => {
    const good = depositSucceededEvent(deposit, NOW, ctx);
    const { tenantid: _removed, ...withoutTenant } = good;
    expect(eventErrors("DepositSucceededEvent", withoutTenant)).not.toEqual([]);
    expect(eventErrors("DepositSucceededEvent", { ...good, specversion: "0.3" })).not.toEqual([]);
    expect(eventErrors("DepositSucceededEvent", { ...good, type: "si.chance.payments.DepositFailed.v1" })).not.toEqual([]);
    expect(eventErrors("DepositSucceededEvent", { ...good, data: { ...good.data, email: "someone@example.test" } })).not.toEqual([]);
    expect(eventErrors("DepositSucceededEvent", { ...good, data: { ...good.data, amount: 0 } })).not.toEqual([]);
    expect(eventErrors("DepositSucceededEvent", { ...good, data: { ...good.data, amount: 12.5 } })).not.toEqual([]);
    expect(eventErrors("DepositSucceededEvent", { ...good, id: "not-a-uuid" })).not.toEqual([]);
  });

  it("describes the events payments consumes", () => {
    const tenantCreated = {
      specversion: "1.0",
      id: "018f3c1e-7a00-7000-8000-0000000000f1",
      type: "si.chance.tenants.TenantCreated.v1",
      tenantid: tenantId,
      data: { tenantId, name: "Acme", slug: "acme", createdAt: "2026-11-01T10:00:00.000Z" },
    };
    const refunded = {
      specversion: "1.0",
      id: "018f3c1e-7a00-7000-8000-0000000000f2",
      type: "si.chance.trading.WithdrawalRefunded.v1",
      tenantid: tenantId,
      data: { withdrawalId: withdrawal.id, userId: "user-1", amount: 1800 },
    };
    expect(eventErrors("TenantCreatedEvent", tenantCreated)).toEqual([]);
    expect(eventErrors("WithdrawalRefundedEvent", refunded)).toEqual([]);
    expect(eventErrors("WithdrawalRefundedEvent", { ...refunded, data: { ...refunded.data, amount: 0 } })).not.toEqual([]);
    expect(eventErrors("TenantCreatedEvent", { ...tenantCreated, data: { name: "Acme" } })).not.toEqual([]);
    expect(asyncapi["channels"].withdrawalRefunded.description).toMatch(/PROPOSAL/);
  });
});
