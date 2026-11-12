import { describe, expect, it } from "vitest";
import { FakePaymentProvider } from "../../src/adapters/memory/fake-provider.js";
import { FakeTrading } from "../../src/adapters/memory/fake-trading.js";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { newDeposit, succeedDeposit } from "../../src/domain/deposit.js";
import { markDebited, newWithdrawal } from "../../src/domain/withdrawal.js";
import { PaymentProviderKeyReused, PaymentProviderUnavailable, TenantNotReady } from "../../src/usecases/errors.js";
import { TENANT_A, TENANT_B } from "../support/harness.js";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const later = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
const ID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const deposit = (n: number, overrides: { userId?: string; key?: string; tenantId?: string; now?: Date } = {}) =>
  newDeposit({ id: ID(n), tenantId: overrides.tenantId ?? TENANT_A, userId: overrides.userId ?? "user-1", amount: 500, idempotencyKey: overrides.key ?? `key-${n}`, requestHash: "h", now: overrides.now ?? NOW });
const withdrawal = (n: number, overrides: { userId?: string; key?: string; now?: Date } = {}) =>
  newWithdrawal({ id: ID(n), tenantId: TENANT_A, userId: overrides.userId ?? "user-1", amount: 300, idempotencyKey: overrides.key ?? `key-${n}`, requestHash: "h", now: overrides.now ?? NOW });

async function storeWithTenants(...tenants: string[]): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.transaction(async (r) => {
    for (const tenant of tenants) await r.tenants.provision(tenant, NOW);
  });
  return store;
}

describe("MemoryStore: tenants", () => {
  it("refuses a tenant without a schema with TenantNotReady, and a value that is no UUID with an error", async () => {
    const store = await storeWithTenants(TENANT_A);
    await expect(store.tenantTransaction(TENANT_B, () => Promise.resolve(1))).rejects.toBeInstanceOf(TenantNotReady);
    await expect(store.tenantTransaction("acme", () => Promise.resolve(1))).rejects.toThrow("A tenant id must be a UUID");
    await expect(store.tenantTransaction(TENANT_A.toUpperCase(), () => Promise.resolve(1))).resolves.toBe(1);
  });

  it("provision is idempotent and the registry lists every tenant, sorted", async () => {
    const store = await storeWithTenants(TENANT_B, TENANT_A, TENANT_A);
    expect(await store.repositories.tenants.list()).toEqual([TENANT_A, TENANT_B]);
    expect(await store.repositories.tenants.exists(TENANT_A)).toBe(true);
    expect(await store.repositories.tenants.exists("acme")).toBe(false);
    await expect(store.transaction((r) => r.tenants.provision("acme", NOW))).rejects.toThrow("UUID");
  });

  it("keeps the rows of one tenant away from another's, also with the same ids and keys", async () => {
    const store = await storeWithTenants(TENANT_A, TENANT_B);
    await store.tenantTransaction(TENANT_A, (r) => r.deposits.insert(deposit(1)));
    expect(await store.tenantTransaction(TENANT_B, (r) => r.deposits.get(ID(1)))).toBeNull();
    expect(await store.tenantTransaction(TENANT_B, (r) => r.deposits.findByIdempotencyKey("user-1", "key-1"))).toBeNull();
    await expect(store.tenantTransaction(TENANT_B, (r) => r.deposits.insert(deposit(1, { tenantId: TENANT_B })))).resolves.toBe(true);
    expect((await store.tenantTransaction(TENANT_A, (r) => r.deposits.get(ID(1))))?.tenantId).toBe(TENANT_A);
  });

  it("rolls back the whole transaction, the inbox record and the tenant's rows, when the work throws", async () => {
    const store = await storeWithTenants(TENANT_A);
    await expect(
      store.tenantTransaction(TENANT_A, async (r) => {
        await r.inbox.markProcessed("c", { id: "e1", type: "t" }, NOW);
        await r.deposits.insert(deposit(1));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.tenantTransaction(TENANT_A, (r) => r.deposits.get(ID(1)))).toBeNull();
    expect(await store.transaction((r) => r.inbox.markProcessed("c", { id: "e1", type: "t" }, NOW))).toBe(true);
  });

  it("a TenantCreated-style transaction: inbox record and schema together, a redelivery changes nothing", async () => {
    const store = new MemoryStore();
    const handle = (eventId: string) =>
      store.transaction(async (r) => {
        if (!(await r.inbox.markProcessed("tenant-created", { id: eventId, type: "t" }, NOW))) return "duplicate";
        await r.tenants.provision(TENANT_A, NOW);
        return "processed";
      });
    expect(await handle("evt-1")).toBe("processed");
    expect(await handle("evt-1")).toBe("duplicate");
    expect(await store.repositories.tenants.list()).toEqual([TENANT_A]);
  });
});

describe("MemoryStore: inbox and provider events", () => {
  it("records an id once per consumer, and purges old records", async () => {
    const store = new MemoryStore();
    const inbox = store.repositories.inbox;
    expect(await inbox.markProcessed("a", { id: "e1", type: "t" }, NOW)).toBe(true);
    expect(await inbox.markProcessed("a", { id: "e1", type: "t" }, NOW)).toBe(false);
    expect(await inbox.markProcessed("b", { id: "e1", type: "t" }, later(10))).toBe(true);
    expect(await inbox.purgeProcessed(later(5))).toBe(1);
    expect(await inbox.markProcessed("a", { id: "e1", type: "t" }, NOW)).toBe(true);
  });

  it("records a provider event id once, and purges old records", async () => {
    const store = new MemoryStore();
    const events = store.repositories.providerEvents;
    expect(await events.markReceived({ id: "evt_1", type: "payout.paid", objectId: "po_1" }, NOW)).toBe(true);
    expect(await events.markReceived({ id: "evt_1", type: "payout.paid", objectId: "po_1" }, NOW)).toBe(false);
    expect(await events.purgeReceived(later(1))).toBe(1);
    expect(await events.markReceived({ id: "evt_1", type: "payout.paid", objectId: "po_1" }, NOW)).toBe(true);
  });
});

describe("MemoryStore: deposits", () => {
  it("inserts once per user and key; another user may use the same key", async () => {
    const store = await storeWithTenants(TENANT_A);
    await store.tenantTransaction(TENANT_A, async (r) => {
      expect(await r.deposits.insert(deposit(1))).toBe(true);
      expect(await r.deposits.insert(deposit(2, { key: "key-1" }))).toBe(false);
      expect(await r.deposits.insert(deposit(3, { key: "key-1", userId: "user-2" }))).toBe(true);
      expect((await r.deposits.findByIdempotencyKey("user-1", "key-1"))?.id).toBe(ID(1));
      expect(await r.deposits.findByIdempotencyKey("user-1", "nope")).toBeNull();
      await expect(r.deposits.insert(deposit(1, { key: "other" }))).rejects.toThrow("exists");
    });
  });

  it("saves the changed state and refuses a row that is gone", async () => {
    const store = await storeWithTenants(TENANT_A);
    await store.tenantTransaction(TENANT_A, async (r) => {
      await r.deposits.insert(deposit(1));
      const stored = await r.deposits.get(ID(1));
      await r.deposits.save(succeedDeposit(stored as NonNullable<typeof stored>, later(1)));
      expect((await r.deposits.get(ID(1)))?.status).toBe("succeeded");
      await expect(r.deposits.save(deposit(9))).rejects.toThrow("does not exist");
    });
  });

  it("claims the pending deposits that are due, oldest first, up to the limit", async () => {
    const store = await storeWithTenants(TENANT_A);
    await store.tenantTransaction(TENANT_A, async (r) => {
      await r.deposits.insert(deposit(1, { now: later(10) }));
      await r.deposits.insert(deposit(2, { now: NOW }));
      await r.deposits.insert(deposit(3, { now: later(5) }));
      const done = deposit(4, { now: NOW });
      await r.deposits.insert(done);
      await r.deposits.save(succeedDeposit(done, later(1)));
      expect(await r.deposits.claimDue(later(29), 10)).toEqual([]);
      expect((await r.deposits.claimDue(later(36), 10)).map((row) => row.id)).toEqual([ID(2), ID(3)]);
      expect((await r.deposits.claimDue(later(60), 2)).map((row) => row.id)).toEqual([ID(2), ID(3)]);
      expect((await r.deposits.claimDue(later(60), 10)).map((row) => row.id)).toEqual([ID(2), ID(3), ID(1)]);
    });
  });
});

describe("MemoryStore: withdrawals", () => {
  it("inserts once per user and key, finds by key, saves", async () => {
    const store = await storeWithTenants(TENANT_A);
    await store.tenantTransaction(TENANT_A, async (r) => {
      expect(await r.withdrawals.insert(withdrawal(1))).toBe(true);
      expect(await r.withdrawals.insert(withdrawal(2, { key: "key-1" }))).toBe(false);
      expect((await r.withdrawals.findByIdempotencyKey("user-1", "key-1"))?.id).toBe(ID(1));
      const stored = await r.withdrawals.get(ID(1), { forUpdate: true });
      await r.withdrawals.save(markDebited(stored as NonNullable<typeof stored>, later(1)));
      expect((await r.withdrawals.get(ID(1)))?.status).toBe("debited");
      expect(await r.withdrawals.get(ID(7))).toBeNull();
      await expect(r.withdrawals.save(withdrawal(9))).rejects.toThrow("does not exist");
      await expect(r.withdrawals.insert(withdrawal(1, { key: "other" }))).rejects.toThrow("exists");
    });
  });

  it("claims requested withdrawals for the debit job and debited ones for the payout job, each when due", async () => {
    const store = await storeWithTenants(TENANT_A);
    await store.tenantTransaction(TENANT_A, async (r) => {
      await r.withdrawals.insert(withdrawal(1, { now: later(2) }));
      await r.withdrawals.insert(withdrawal(2, { now: NOW }));
      const debited = withdrawal(3, { now: NOW });
      await r.withdrawals.insert(debited);
      await r.withdrawals.save(markDebited(debited, later(1)));
      expect((await r.withdrawals.claimDebitDue(later(1), 10)).map((row) => row.id)).toEqual([ID(2)]);
      expect((await r.withdrawals.claimDebitDue(later(5), 10)).map((row) => row.id)).toEqual([ID(2), ID(1)]);
      expect(await r.withdrawals.claimPayoutDue(NOW, 10)).toEqual([]);
      expect((await r.withdrawals.claimPayoutDue(later(1), 10)).map((row) => row.id)).toEqual([ID(3)]);
      expect(await r.withdrawals.claimDebitDue(later(5), 1)).toHaveLength(1);
    });
  });
});

describe("FakeTrading", () => {
  const request = (n: number, amount = 300) => ({ withdrawalId: ID(n), tenantId: TENANT_A, userId: "user-1", amount });

  it("debits once per withdrawal id, however often it is asked", async () => {
    const trading = new FakeTrading();
    trading.setCredits(TENANT_A, "user-1", 1000);
    expect(await trading.debit(request(1))).toEqual({ kind: "debited" });
    expect(await trading.debit(request(1))).toEqual({ kind: "debited" });
    expect(trading.creditsOf(TENANT_A, "user-1")).toBe(700);
    expect(trading.requests).toHaveLength(2);
    expect(trading.hasDebited(ID(1))).toBe(true);
  });

  it("answers insufficient when the credits are too few, and takes nothing", async () => {
    const trading = new FakeTrading({ defaultCredits: 100 });
    expect(await trading.debit(request(1))).toEqual({ kind: "insufficient" });
    expect(trading.creditsOf(TENANT_A, "user-1")).toBe(100);
    expect(trading.hasDebited(ID(1))).toBe(false);
  });

  it("can lose answers after debiting, answer with forced outcomes, and refund", async () => {
    const trading = new FakeTrading();
    trading.loseNextAnswers(1);
    expect((await trading.debit(request(1))).kind).toBe("unknown");
    expect(trading.hasDebited(ID(1))).toBe(true);
    expect(await trading.debit(request(1))).toEqual({ kind: "debited" });
    trading.answerNext({ kind: "circuit_open" });
    expect(await trading.debit(request(2))).toEqual({ kind: "circuit_open" });
    expect(trading.hasDebited(ID(2))).toBe(false);
    trading.refund(TENANT_A, "user-1", ID(1), 300);
    expect(trading.creditsOf(TENANT_A, "user-1")).toBe(1_000_000);
    trading.refund(TENANT_A, "user-1", ID(1), 300);
    expect(trading.creditsOf(TENANT_A, "user-1")).toBe(1_000_000);
  });
});

describe("FakePaymentProvider", () => {
  const session = { depositId: ID(1), tenantId: TENANT_A, amount: 500, successUrl: "https://example.test/ok", cancelUrl: "https://example.test/no" };
  const payout = { withdrawalId: ID(2), tenantId: TENANT_A, userId: "user-1", amount: 300 };

  it("creates a session once per key, and a key with another body is refused", async () => {
    const provider = new FakePaymentProvider();
    const first = await provider.createCheckoutSession(session);
    expect(first).toMatchObject({ status: "open", amount: 500, metadata: { tenantId: TENANT_A, depositId: ID(1) } });
    expect((await provider.createCheckoutSession(session)).id).toBe(first.id);
    await expect(provider.createCheckoutSession({ ...session, amount: 600 })).rejects.toBeInstanceOf(PaymentProviderKeyReused);
    expect(provider.sessionList()).toHaveLength(1);
  });

  it("plays the buyer: pay, decline, expire; a closed session cannot change again", async () => {
    const provider = new FakePaymentProvider();
    const created = await provider.createCheckoutSession(session);
    provider.pay(created.id);
    expect((await provider.getCheckoutSession(created.id))?.status).toBe("completed");
    expect(() => provider.decline(created.id)).toThrow("not open");
    const other = await provider.createCheckoutSession({ ...session, depositId: ID(3) });
    provider.decline(other.id);
    expect((await provider.getCheckoutSession(other.id))?.status).toBe("declined");
    const third = await provider.createCheckoutSession({ ...session, depositId: ID(4) });
    provider.expire(third.id);
    expect((await provider.getCheckoutSession(third.id))?.status).toBe("expired");
  });

  it("settles payouts as paid, or as failed (declined) in test mode", async () => {
    const provider = new FakePaymentProvider();
    const paid = await provider.createPayout(payout);
    expect((await provider.createPayout(payout)).id).toBe(paid.id);
    await expect(provider.createPayout({ ...payout, amount: 1 })).rejects.toBeInstanceOf(PaymentProviderKeyReused);
    provider.settlePayouts();
    expect((await provider.getPayout(paid.id))?.status).toBe("paid");
    provider.declinePayouts = true;
    const failed = await provider.createPayout({ ...payout, withdrawalId: ID(5) });
    provider.settlePayouts();
    expect(await provider.getPayout(failed.id)).toMatchObject({ status: "failed", failureReason: "declined" });
    expect(provider.payoutList()).toHaveLength(2);
  });

  it("forgets everything on restart (a 404 for the payout) and can fail like an outage", async () => {
    const provider = new FakePaymentProvider();
    const created = await provider.createPayout(payout);
    provider.restart();
    expect(await provider.getPayout(created.id)).toBeNull();
    expect(await provider.getCheckoutSession("cs_x")).toBeNull();
    provider.failNext(new PaymentProviderUnavailable("down"));
    await expect(provider.getPayout("po_x")).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    expect(await provider.getPayout("po_x")).toBeNull();
    expect(provider.calls).toEqual(["createPayout", "getPayout", "getCheckoutSession", "getPayout", "getPayout"]);
  });
});
