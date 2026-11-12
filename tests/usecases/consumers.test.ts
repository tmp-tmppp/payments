import { describe, expect, it } from "vitest";
import type { ReceivedEvent } from "../../src/domain/consumed-events.js";
import { TenantNotReady, UnprocessableEvent } from "../../src/usecases/errors.js";
import { TENANT_CREATED_CONSUMER, WITHDRAWAL_REFUNDED_CONSUMER, tenantCreatedHandler, withdrawalRefundedHandler } from "../../src/usecases/consumers.js";
import { sendPayouts } from "../../src/usecases/jobs.js";
import { TENANT_A } from "../support/harness.js";
import { debitedWithdrawal, setupSaga, withdrawalWithPayout } from "../support/saga.js";

const NEW_TENANT = "018f3c1e-7a00-7000-8000-0000000000dd";

const received = (overrides: Partial<ReceivedEvent> = {}): ReceivedEvent => ({
  id: "evt-1",
  type: "si.chance.tenants.TenantCreated.v1",
  source: "/chance/tenants",
  subject: `tenant/${NEW_TENANT}`,
  time: "2026-11-01T10:00:00.000Z",
  tenantId: NEW_TENANT,
  correlationId: "corr",
  causationId: "cause",
  data: { tenantId: NEW_TENANT, name: "Acme", slug: "acme" },
  ...overrides,
});

describe("TenantCreated", () => {
  it("creates the tenant's schema and records the event id in the same transaction", async () => {
    const saga = await setupSaga();
    expect(await saga.store.repositories.tenants.exists(NEW_TENANT)).toBe(false);
    await tenantCreatedHandler(saga.deps)(received());
    expect(await saga.store.repositories.tenants.exists(NEW_TENANT)).toBe(true);
    expect(saga.inbox()).toMatchObject([{ consumer: TENANT_CREATED_CONSUMER, id: "evt-1" }]);
  });

  it("changes nothing for a redelivery of the same event, and is harmless for the same tenant under another event id", async () => {
    const saga = await setupSaga();
    const handle = tenantCreatedHandler(saga.deps);
    await handle(received());
    await handle(received());
    await handle(received({ id: "evt-2" }));
    expect(saga.inbox()).toHaveLength(2);
    expect(await saga.store.repositories.tenants.list()).toEqual([TENANT_A, "018f3c1e-7a00-7000-8000-0000000000bb", NEW_TENANT].sort());
  });

  it("drops an event that can never be handled: another type, no valid tenant id, a data tenant that differs", async () => {
    const saga = await setupSaga();
    const handle = tenantCreatedHandler(saga.deps);
    await expect(handle(received({ type: "si.chance.tenants.TenantRenamed.v1" }))).rejects.toBeInstanceOf(UnprocessableEvent);
    await expect(handle(received({ data: {} }))).rejects.toBeInstanceOf(UnprocessableEvent);
    await expect(handle(received({ data: { tenantId: TENANT_A } }))).rejects.toBeInstanceOf(UnprocessableEvent);
    expect(saga.inbox()).toEqual([]);
  });

  it("leaves no inbox row behind when the schema cannot be made (a rollback keeps both or neither)", async () => {
    const saga = await setupSaga();
    const broken = { ...saga.deps, store: Object.create(saga.store, { transaction: { value: <T>(work: (repos: never) => Promise<T>) => saga.store.transaction((repos) => work({ ...repos, tenants: { ...repos.tenants, provision: () => Promise.reject(new Error("ddl failed")) } } as never)) } }) };
    await expect(tenantCreatedHandler(broken)(received())).rejects.toThrow("ddl failed");
    expect(saga.inbox()).toEqual([]);
    expect(await saga.store.repositories.tenants.exists(NEW_TENANT)).toBe(false);
  });
});

describe("WithdrawalRefunded", () => {
  async function failedWithdrawal() {
    const saga = await setupSaga();
    const { withdrawal } = await withdrawalWithPayout(saga, 900);
    saga.provider.declinePayouts = true;
    saga.provider.settlePayouts();
    saga.clock.advanceMs(11_000);
    await sendPayouts(saga.deps, 10);
    expect(saga.withdrawals()[0]?.status).toBe("failed");
    const refunded = (overrides: Partial<ReceivedEvent> = {}, data: Record<string, unknown> = {}): ReceivedEvent =>
      received({
        id: "evt-refund",
        type: "si.chance.trading.WithdrawalRefunded.v1",
        tenantId: TENANT_A,
        data: { withdrawalId: withdrawal.id, userId: "user-1", amount: 900, ...data },
        ...overrides,
      });
    return { saga, withdrawal, refunded };
  }

  it("ends the saga: failed -> refunded, with the reason kept", async () => {
    const { saga, refunded } = await failedWithdrawal();
    await withdrawalRefundedHandler(saga.deps)(refunded());
    expect(saga.withdrawals()[0]).toMatchObject({ status: "refunded", reason: "declined" });
    expect(saga.withdrawals()[0]?.completedAt).not.toBeNull();
    expect(saga.inbox().some((row) => row.consumer === WITHDRAWAL_REFUNDED_CONSUMER && row.id === "evt-refund")).toBe(true);
  });

  it("changes nothing for a redelivery", async () => {
    const { saga, refunded } = await failedWithdrawal();
    const handle = withdrawalRefundedHandler(saga.deps);
    await handle(refunded());
    const after = saga.withdrawals()[0]?.updatedAt;
    saga.clock.advanceMs(5000);
    await handle(refunded());
    expect(saga.withdrawals()[0]?.updatedAt).toEqual(after);
  });

  it.each([
    ["another user", { userId: "user-9" }],
    ["another amount", { amount: 901 }],
    ["an unknown withdrawal", { withdrawalId: "018f3c1e-7a00-7000-8000-000000000777" }],
  ])("logs and drops an event for %s, without redelivery", async (_name, data) => {
    const { saga, refunded } = await failedWithdrawal();
    await withdrawalRefundedHandler(saga.deps)(refunded({}, data));
    expect(saga.withdrawals()[0]?.status).toBe("failed");
    expect(saga.logger.lines.some((line) => line.level === "warn" && /dropped/.test(line.message ?? ""))).toBe(true);
  });

  it("drops an event for a withdrawal that did not fail", async () => {
    const saga = await setupSaga();
    const withdrawal = await debitedWithdrawal(saga, 900);
    await withdrawalRefundedHandler(saga.deps)(
      received({ id: "evt-x", type: "si.chance.trading.WithdrawalRefunded.v1", tenantId: TENANT_A, data: { withdrawalId: withdrawal.id, userId: "user-1", amount: 900 } }),
    );
    expect(saga.withdrawals()[0]?.status).toBe("debited");
  });

  it("is delivered again while the tenant's schema is not there yet, and drops what can never fit", async () => {
    const saga = await setupSaga();
    const handle = withdrawalRefundedHandler(saga.deps);
    const base = { type: "si.chance.trading.WithdrawalRefunded.v1", data: { withdrawalId: "018f3c1e-7a00-7000-8000-000000000777", userId: "u", amount: 5 } };
    await expect(handle(received({ ...base, tenantId: NEW_TENANT }))).rejects.toBeInstanceOf(TenantNotReady);
    await expect(handle(received({ ...base, type: "si.chance.trading.Other.v1", tenantId: TENANT_A }))).rejects.toBeInstanceOf(UnprocessableEvent);
    await expect(handle(received({ ...base, data: { withdrawalId: "x" }, tenantId: TENANT_A }))).rejects.toBeInstanceOf(UnprocessableEvent);
  });
});
