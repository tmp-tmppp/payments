import { describe, expect, it } from "vitest";
import { Conflict, NotFound, PaymentProviderRejected, PaymentProviderUnavailable, TenantNotReady, Unavailable, ValidationFailed } from "../../src/usecases/errors.js";
import { createDeposit, getDeposit } from "../../src/usecases/deposits.js";
import { CHECKOUT, TENANT_A, TENANT_B, createCore, provisionTenants, who } from "../support/harness.js";

async function setup() {
  const core = createCore();
  await provisionTenants(core, TENANT_A, TENANT_B);
  const storedDeposits = () => core.store.snapshot().tenants.get(TENANT_A)?.deposits ?? [];
  return { ...core, storedDeposits };
}

describe("createDeposit", () => {
  it("stores a pending deposit, asks the provider for a checkout session with the fixed return URLs, and returns the link", async () => {
    const { deps, provider, clock } = await setup();
    const { deposit, created } = await createDeposit(deps, who(), { idempotencyKey: "key-1", amount: 2500 });

    expect(created).toBe(true);
    expect(deposit).toMatchObject({ status: "pending", amount: 2500, userId: "user-1", tenantId: TENANT_A, failureReason: null });
    expect(deposit.checkoutUrl).toMatch(/^http/);
    expect(deposit.expiresAt.getTime() - clock.now().getTime()).toBe(30 * 60_000);
    expect(deposit.nextCheckAt?.getTime()).toBe(clock.now().getTime() + 60_000);

    const [session] = provider.sessionList();
    expect(session).toMatchObject({ id: deposit.providerSessionId, status: "open", amount: 2500, metadata: { tenantId: TENANT_A, depositId: deposit.id } });
    expect(CHECKOUT.successUrl).toMatch(/^https:/);
  });

  it("answers a repeat of the same key and body with the same deposit and asks the provider once", async () => {
    const { deps, provider } = await setup();
    const first = await createDeposit(deps, who(), { idempotencyKey: "key-1", amount: 500 });
    const again = await createDeposit(deps, who(), { idempotencyKey: "key-1", amount: 500 });
    expect(again.created).toBe(false);
    expect(again.deposit.id).toBe(first.deposit.id);
    expect(provider.sessionList()).toHaveLength(1);
  });

  it("makes one deposit when the same key arrives twice at once", async () => {
    const { deps, provider, storedDeposits } = await setup();
    const results = await Promise.all([
      createDeposit(deps, who(), { idempotencyKey: "same", amount: 700 }),
      createDeposit(deps, who(), { idempotencyKey: "same", amount: 700 }),
    ]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].deposit.id).toBe(results[1].deposit.id);
    expect(provider.sessionList()).toHaveLength(1);
    expect(storedDeposits()).toHaveLength(1);
  });

  it("refuses the same key with another body, and gives another user the same key freely", async () => {
    const { deps } = await setup();
    await createDeposit(deps, who(), { idempotencyKey: "key-1", amount: 500 });
    await expect(createDeposit(deps, who(), { idempotencyKey: "key-1", amount: 600 })).rejects.toMatchObject({ kind: "conflict", code: "idempotency_key_reused" });
    await expect(createDeposit(deps, who(), { idempotencyKey: "key-1", amount: 600 })).rejects.toBeInstanceOf(Conflict);
    const other = await createDeposit(deps, who("user-2"), { idempotencyKey: "key-1", amount: 600 });
    expect(other.created).toBe(true);
  });

  it.each([0, -5, 1.5, 1_000_001, "500", null, undefined, Number.NaN])("refuses the amount %s", async (amount) => {
    const { deps, provider } = await setup();
    await expect(createDeposit(deps, who(), { idempotencyKey: "k", amount })).rejects.toBeInstanceOf(ValidationFailed);
    expect(provider.calls).toEqual([]);
  });

  it.each([undefined, "", "with space", "x".repeat(256), 5])("refuses the Idempotency-Key %s", async (key) => {
    const { deps } = await setup();
    await expect(createDeposit(deps, who(), { idempotencyKey: key, amount: 500 })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("holds no database transaction open while it waits for the provider", async () => {
    const { deps, provider } = await setup();
    let open = 0;
    const real = deps.store.tenantTransaction.bind(deps.store);
    deps.store.tenantTransaction = ((tenantId: string, work: never) => {
      open += 1;
      return real(tenantId, work).finally(() => {
        open -= 1;
      });
    }) as never;
    const seen: number[] = [];
    const create = provider.createCheckoutSession.bind(provider);
    provider.createCheckoutSession = (input) => {
      seen.push(open);
      return create(input);
    };
    await createDeposit(deps, who(), { idempotencyKey: "key-1", amount: 500 });
    expect(seen).toEqual([0]);
  });

  it("answers 503 with a time to come back when the provider is down; the pending deposit stays, and the same key finishes it", async () => {
    const { deps, provider, storedDeposits, logger } = await setup();
    provider.failNext(new PaymentProviderUnavailable("circuit open"));
    const failure = await createDeposit(deps, who(), { idempotencyKey: "key-1", amount: 500 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Unavailable);
    expect(failure).toMatchObject({ code: "provider_unavailable", retryAfterSeconds: 10 });
    expect(storedDeposits()).toHaveLength(1);
    expect(storedDeposits()[0]).toMatchObject({ status: "pending", providerSessionId: null, checkoutUrl: null });
    expect(logger.lines.some((line) => line.level === "warn")).toBe(true);

    // The same key works once the provider is back: it is the same deposit, now with its session.
    const retry = await createDeposit(deps, who(), { idempotencyKey: "key-1", amount: 500 });
    expect(retry.created).toBe(false);
    expect(retry.deposit.checkoutUrl).toMatch(/^http/);
    expect(storedDeposits()).toHaveLength(1);
    expect(storedDeposits()[0]?.providerSessionId).toBe(provider.sessionList()[0]?.id);
  });

  it("treats a 4xx of the provider as our own mistake: logged as an error, a longer wait, the deposit waits without a session", async () => {
    const { deps, provider, storedDeposits, logger } = await setup();
    provider.failNext(new PaymentProviderRejected(401, "unauthorized", "bad key"));
    await expect(createDeposit(deps, who(), { idempotencyKey: "k", amount: 500 })).rejects.toMatchObject({ code: "provider_unavailable", retryAfterSeconds: 60 });
    expect(storedDeposits()).toHaveLength(1);
    expect(storedDeposits()[0]?.providerSessionId).toBeNull();
    expect(logger.lines.some((line) => line.level === "error")).toBe(true);
  });

  it("lets an unexpected error through unchanged", async () => {
    const { deps, provider } = await setup();
    provider.failNext(new TypeError("a bug"));
    await expect(createDeposit(deps, who(), { idempotencyKey: "k", amount: 500 })).rejects.toBeInstanceOf(TypeError);
  });

  it("answers 503 tenant_not_ready for a tenant whose schema does not exist", async () => {
    const { deps, provider } = await setup();
    const failure = await createDeposit(deps, who("user-1", "018f3c1e-7a00-7000-8000-0000000000cc"), { idempotencyKey: "k", amount: 500 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TenantNotReady);
    expect(provider.calls).toEqual([]);
  });
});

describe("getDeposit", () => {
  it("returns the caller's own deposit", async () => {
    const { deps } = await setup();
    const { deposit } = await createDeposit(deps, who(), { idempotencyKey: "k", amount: 500 });
    expect((await getDeposit(deps, who(), deposit.id)).id).toBe(deposit.id);
  });

  it("answers not found for another user's deposit, another tenant's deposit, an unknown id and a bad id", async () => {
    const { deps } = await setup();
    const { deposit } = await createDeposit(deps, who(), { idempotencyKey: "k", amount: 500 });
    for (const caller of [who("user-2"), who("user-1", TENANT_B)]) {
      await expect(getDeposit(deps, caller, deposit.id)).rejects.toBeInstanceOf(NotFound);
    }
    await expect(getDeposit(deps, who(), "018f3c1e-7a00-7000-8000-000000000999")).rejects.toBeInstanceOf(NotFound);
    await expect(getDeposit(deps, who(), "not-an-id")).rejects.toMatchObject({ code: "deposit_not_found" });
  });
});
