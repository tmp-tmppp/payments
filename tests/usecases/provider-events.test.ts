import { describe, expect, it } from "vitest";
import { eventErrors } from "../support/contracts.js";
import { PaymentProviderRejected, PaymentProviderUnavailable, TenantNotReady } from "../../src/usecases/errors.js";
import { handleProviderEvent } from "../../src/usecases/provider-events.js";
import type { ProviderEventInput } from "../../src/usecases/provider-events.js";
import { TENANT_A, TENANT_B } from "../support/harness.js";
import { pendingDeposit, setupSaga, withdrawalWithPayout, debitedWithdrawal } from "../support/saga.js";
import type { Saga } from "../support/saga.js";

let counter = 0;
const sessionEvent = (objectId: string, type = "checkout.session.completed"): ProviderEventInput => {
  counter += 1;
  return { id: `evt_${String(counter).padStart(24, "0")}`, type, objectKind: "checkout_session", objectId, correlationId: "corr-hook" };
};
const payoutEvent = (objectId: string, type = "payout.paid"): ProviderEventInput => ({ ...sessionEvent(objectId, type), objectKind: "payout" });

const eventOf = (saga: Saga, index = 0) => saga.outbox()[index]?.payload as Record<string, any>;

describe("a webhook about a checkout session", () => {
  it("completes the deposit when the session read back is completed, and writes DepositSucceeded in the same transaction", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider.pay(deposit.providerSessionId as string);

    const result = await handleProviderEvent(saga.deps, sessionEvent(deposit.providerSessionId as string));

    expect(result).toBe("processed");
    expect(saga.deposits()[0]).toMatchObject({ status: "succeeded", nextCheckAt: null });
    expect(saga.deposits()[0]?.completedAt).not.toBeNull();
    expect(saga.outbox()).toHaveLength(1);
    const event = eventOf(saga);
    expect(event).toMatchObject({
      type: "si.chance.payments.DepositSucceeded.v1",
      subject: `deposit/${deposit.id}`,
      tenantid: TENANT_A,
      correlationid: "corr-hook",
      data: { depositId: deposit.id, tenantId: TENANT_A, userId: "user-1", amount: 2500 },
    });
    expect(saga.outbox()[0]?.subject).toBe(`chance.payments.DepositSucceeded.${TENANT_A}`);
    expect(eventErrors("DepositSucceededEvent", event)).toEqual([]);
    expect(JSON.stringify(event)).not.toMatch(/@|email|name/i);
    expect(saga.providerEvents()).toHaveLength(1);
  });

  it("changes nothing for a repeat of the same provider event id", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider.pay(deposit.providerSessionId as string);
    const event = sessionEvent(deposit.providerSessionId as string);
    expect(await handleProviderEvent(saga.deps, event)).toBe("processed");
    expect(await handleProviderEvent(saga.deps, event)).toBe("duplicate");
    expect(saga.outbox()).toHaveLength(1);
    expect(saga.providerEvents()).toHaveLength(1);
  });

  it("acts on the state it reads back, never on the type of the event", async () => {
    const saga = await setupSaga();
    const open = await pendingDeposit(saga);
    // The event claims completion, the provider says the session is still open.
    expect(await handleProviderEvent(saga.deps, sessionEvent(open.providerSessionId as string, "checkout.session.completed"))).toBe("ignored");
    expect(saga.deposits()[0]?.status).toBe("pending");

    // The event claims a decline, the provider says it was paid.
    saga.provider.pay(open.providerSessionId as string);
    expect(await handleProviderEvent(saga.deps, sessionEvent(open.providerSessionId as string, "checkout.session.declined"))).toBe("processed");
    expect(saga.deposits()[0]?.status).toBe("succeeded");
  });

  it.each([
    ["decline", "declined"],
    ["expire", "expired"],
  ] as const)("fails the deposit with reason %s and writes DepositFailed", async (action, reason) => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider[action](deposit.providerSessionId as string);
    expect(await handleProviderEvent(saga.deps, sessionEvent(deposit.providerSessionId as string, "checkout.session.declined"))).toBe("processed");
    expect(saga.deposits()[0]).toMatchObject({ status: "failed", failureReason: reason });
    const event = eventOf(saga);
    expect(event).toMatchObject({ type: "si.chance.payments.DepositFailed.v1", data: { depositId: deposit.id, reason } });
    expect(eventErrors("DepositFailedEvent", event)).toEqual([]);
  });

  it("changes nothing when the deposit already ended (a late repeat with a new event id)", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider.pay(deposit.providerSessionId as string);
    await handleProviderEvent(saga.deps, sessionEvent(deposit.providerSessionId as string));
    expect(await handleProviderEvent(saga.deps, sessionEvent(deposit.providerSessionId as string))).toBe("ignored");
    expect(saga.outbox()).toHaveLength(1);
  });

  it("logs a manual decision when the session of a failed deposit is completed", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider.pay(deposit.providerSessionId as string);
    // The deposit failed before the webhook was handled (the expiry job and the webhook raced).
    const { failDeposit } = await import("../../src/domain/deposit.js");
    await saga.store.tenantTransaction(TENANT_A, async (repos) => {
      const row = await repos.deposits.get(deposit.id);
      await repos.deposits.save(failDeposit(row!, "expired", saga.clock.now()));
    });
    expect(await handleProviderEvent(saga.deps, sessionEvent(deposit.providerSessionId as string))).toBe("ignored");
    expect(saga.deposits()[0]?.status).toBe("failed");
    expect(saga.logger.lines.some((line) => line.level === "error" && /manual decision/.test(line.message ?? ""))).toBe(true);
  });

  it("ignores a session the provider does not know, and remembers the event", async () => {
    const saga = await setupSaga();
    const event = sessionEvent("cs_unknown");
    expect(await handleProviderEvent(saga.deps, event)).toBe("ignored");
    expect(await handleProviderEvent(saga.deps, event)).toBe("duplicate");
    expect(saga.outbox()).toEqual([]);
  });

  it("ignores a session whose metadata is no tenant and deposit of ours", async () => {
    const saga = await setupSaga();
    const session = await saga.provider.createCheckoutSession({ depositId: "not-a-uuid", tenantId: TENANT_A, amount: 10, successUrl: "https://a.example", cancelUrl: "https://b.example" });
    saga.provider.pay(session.id);
    expect(await handleProviderEvent(saga.deps, sessionEvent(session.id))).toBe("ignored");
  });

  it("ignores a session that does not match the deposit it names (another session, or no such deposit)", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga, 2500);
    const stranger = await saga.provider.createCheckoutSession({ depositId: deposit.id.replace(/1$/, "2"), tenantId: TENANT_A, amount: 2500, successUrl: "https://a.example", cancelUrl: "https://b.example" });
    saga.provider.pay(stranger.id);
    expect(await handleProviderEvent(saga.deps, sessionEvent(stranger.id))).toBe("ignored");
    // Right deposit id, but the session is not the one the deposit made.
    saga.provider.restart();
    const forged = await saga.provider.createCheckoutSession({ depositId: deposit.id, tenantId: TENANT_A, amount: 99, successUrl: "https://a.example", cancelUrl: "https://b.example" });
    saga.provider.pay(forged.id);
    expect(await handleProviderEvent(saga.deps, sessionEvent(forged.id))).toBe("ignored");
    expect(saga.deposits()[0]?.status).toBe("pending");
    expect(saga.logger.lines.filter((line) => line.level === "error").length).toBeGreaterThanOrEqual(2);
  });

  it("does not record the event when the provider cannot be asked, so its retry is handled", async () => {
    const saga = await setupSaga();
    const deposit = await pendingDeposit(saga);
    saga.provider.pay(deposit.providerSessionId as string);
    const event = sessionEvent(deposit.providerSessionId as string);
    saga.provider.failNext(new PaymentProviderUnavailable("down"));
    await expect(handleProviderEvent(saga.deps, event)).rejects.toMatchObject({ code: "provider_unavailable", retryAfterSeconds: 10 });
    expect(saga.providerEvents()).toEqual([]);
    expect(await handleProviderEvent(saga.deps, event)).toBe("processed");
  });

  it("answers 503 (retry later) when the provider refuses the read back, and lets other errors through", async () => {
    const saga = await setupSaga();
    saga.provider.failNext(new PaymentProviderRejected(401, null, "bad key"));
    await expect(handleProviderEvent(saga.deps, sessionEvent("cs_1"))).rejects.toMatchObject({ retryAfterSeconds: 60 });
    saga.provider.failNext(new RangeError("a bug"));
    await expect(handleProviderEvent(saga.deps, sessionEvent("cs_1"))).rejects.toBeInstanceOf(RangeError);
  });

  it("answers tenant_not_ready for a tenant that has no schema (the event is retried)", async () => {
    const saga = await setupSaga();
    const session = await saga.provider.createCheckoutSession({ depositId: "018f3c1e-7a00-7000-8000-000000000042", tenantId: "018f3c1e-7a00-7000-8000-0000000000cc", amount: 10, successUrl: "https://a.example", cancelUrl: "https://b.example" });
    await expect(handleProviderEvent(saga.deps, sessionEvent(session.id))).rejects.toBeInstanceOf(TenantNotReady);
  });

  it("keeps the tenants apart: a session of tenant B changes only tenant B's deposit", async () => {
    const saga = await setupSaga();
    const a = await pendingDeposit(saga, 100, "user-1", TENANT_A);
    const b = await pendingDeposit(saga, 100, "user-1", TENANT_B);
    saga.provider.pay(b.providerSessionId as string);
    await handleProviderEvent(saga.deps, sessionEvent(b.providerSessionId as string));
    expect(saga.deposits(TENANT_A)[0]?.id).toBe(a.id);
    expect(saga.deposits(TENANT_A)[0]?.status).toBe("pending");
    expect(saga.deposits(TENANT_B)[0]?.status).toBe("succeeded");
  });
});

describe("a webhook about a payout", () => {
  it("ends the withdrawal as paid out when the payout read back is paid, with WithdrawalSucceeded", async () => {
    const saga = await setupSaga();
    const { withdrawal, payout } = await withdrawalWithPayout(saga);
    saga.provider.settlePayouts();

    expect(await handleProviderEvent(saga.deps, payoutEvent(payout.id))).toBe("processed");
    expect(saga.withdrawals()[0]).toMatchObject({ id: withdrawal.id, status: "paid_out", nextPayoutAt: null });
    const event = eventOf(saga);
    expect(event).toMatchObject({ type: "si.chance.payments.WithdrawalSucceeded.v1", data: { withdrawalId: withdrawal.id, userId: "user-1", amount: 1800 } });
    expect(eventErrors("WithdrawalSucceededEvent", event)).toEqual([]);
  });

  it("fails the withdrawal with reason declined when the payout failed, with WithdrawalFailed", async () => {
    const saga = await setupSaga();
    const { withdrawal, payout } = await withdrawalWithPayout(saga);
    saga.provider.declinePayouts = true;
    saga.provider.settlePayouts();

    expect(await handleProviderEvent(saga.deps, payoutEvent(payout.id, "payout.failed"))).toBe("processed");
    expect(saga.withdrawals()[0]).toMatchObject({ status: "failed", reason: "declined" });
    const event = eventOf(saga);
    expect(event).toMatchObject({ type: "si.chance.payments.WithdrawalFailed.v1", data: { withdrawalId: withdrawal.id, reason: "declined" } });
    expect(eventErrors("WithdrawalFailedEvent", event)).toEqual([]);
    // The central logging alert (REQ-19) matches the text "WithdrawalFailed" in a payments line.
    const warned = saga.logger.lines.filter((line) => line.level === "warn" && line.message?.startsWith("WithdrawalFailed:"));
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields).toMatchObject({ withdrawalId: withdrawal.id, tenantId: withdrawal.tenantId, reason: "declined" });
    expect(warned[0]?.fields).toHaveProperty("correlationId");
  });

  it("writes no WithdrawalFailed line for a payout that was paid", async () => {
    const saga = await setupSaga();
    const { payout } = await withdrawalWithPayout(saga);
    saga.provider.settlePayouts();
    expect(await handleProviderEvent(saga.deps, payoutEvent(payout.id, "payout.paid"))).toBe("processed");
    expect(saga.logger.lines.some((line) => line.message?.includes("WithdrawalFailed"))).toBe(false);
  });

  it("changes nothing while the payout is pending, whatever the event says", async () => {
    const saga = await setupSaga();
    const { payout } = await withdrawalWithPayout(saga);
    expect(await handleProviderEvent(saga.deps, payoutEvent(payout.id, "payout.paid"))).toBe("ignored");
    expect(saga.withdrawals()[0]?.status).toBe("debited");
  });

  it("ties a payout to its withdrawal when the job created it but did not save its id", async () => {
    const saga = await setupSaga();
    const withdrawal = await debitedWithdrawal(saga);
    const payout = await saga.provider.createPayout({ withdrawalId: withdrawal.id, tenantId: TENANT_A, userId: "user-1", amount: 1800 });
    saga.provider.settlePayouts();
    expect(await handleProviderEvent(saga.deps, payoutEvent(payout.id))).toBe("processed");
    expect(saga.withdrawals()[0]).toMatchObject({ status: "paid_out", providerPayoutId: payout.id });
  });

  it("ignores a payout that does not match the withdrawal: another amount, another user, another payout id", async () => {
    const saga = await setupSaga();
    const { withdrawal: w2 } = await withdrawalWithPayout(saga, 500, "user-2");
    const w1 = await debitedWithdrawal(saga, 1800);

    const amount = await saga.provider.createPayout({ withdrawalId: w1.id, tenantId: TENANT_A, userId: "user-1", amount: 1801 });
    saga.provider.settlePayouts();
    expect(await handleProviderEvent(saga.deps, payoutEvent(amount.id))).toBe("ignored");

    saga.provider.restart();
    const user = await saga.provider.createPayout({ withdrawalId: w1.id, tenantId: TENANT_A, userId: "user-9", amount: 1800 });
    saga.provider.settlePayouts();
    expect(await handleProviderEvent(saga.deps, payoutEvent(user.id))).toBe("ignored");

    // w2 already has its own payout id; this one is another payout made for it.
    const second = await saga.provider.createPayout({ withdrawalId: w2.id, tenantId: TENANT_A, userId: "user-2", amount: 500 });
    saga.provider.settlePayouts();
    expect(await handleProviderEvent(saga.deps, payoutEvent(second.id))).toBe("ignored");

    expect(saga.withdrawals().map((row) => row.status)).toEqual(["debited", "debited"]);
    expect(saga.logger.lines.filter((line) => line.level === "error")).toHaveLength(3);
  });

  it("ignores a payout of an unknown id", async () => {
    const saga = await setupSaga();
    expect(await handleProviderEvent(saga.deps, payoutEvent("po_unknown"))).toBe("ignored");
  });

  it("does nothing to a withdrawal that already ended", async () => {
    const saga = await setupSaga();
    const { payout } = await withdrawalWithPayout(saga);
    saga.provider.settlePayouts();
    await handleProviderEvent(saga.deps, payoutEvent(payout.id));
    expect(await handleProviderEvent(saga.deps, payoutEvent(payout.id))).toBe("ignored");
    expect(saga.outbox()).toHaveLength(1);
  });
});
