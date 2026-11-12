import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { JWTVerifyGetKey } from "jose";
import { FakePaymentProvider } from "../../src/adapters/memory/fake-provider.js";
import { FakeTrading } from "../../src/adapters/memory/fake-trading.js";
import { MemoryEventPublisher } from "../../src/adapters/memory/memory-publisher.js";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { signWebhook } from "../../src/domain/webhook-signature.js";
import { createLogger } from "../../src/logger.js";
import { createUseCases } from "../../src/usecases/application.js";
import type { Caller, Clock, IdGenerator, Logger, PaymentsDeps, RuntimeSettings } from "../../src/usecases/ports.js";
import { Conflict, NotFound, Unavailable, ValidationFailed, guardDomain } from "../../src/usecases/errors.js";
import { parseAmount } from "../../src/domain/amount.js";
import { authenticate, requireAuth, requireTenantUser } from "../../src/web/auth.js";
import type { AuthOptions } from "../../src/web/auth.js";
import { buildApp } from "../../src/web/app.js";
import type { WebDeps } from "../../src/web/app.js";
import { AUDIENCE, ISSUER, createTestKeys } from "./tokens.js";

export class TestClock implements Clock {
  constructor(private current = new Date("2026-11-01T10:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceHours(hours: number): void {
    this.advanceMs(hours * 3_600_000);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  /** Moves forward by a millisecond so that rows written one after another sort in a known order. */
  tick(): void {
    this.current = new Date(this.current.getTime() + 1);
  }
}

/** Ids that are valid UUIDs and predictable: ...0001, ...0002 */
export class SequentialIds implements IdGenerator {
  private counter = 0;
  newId(): string {
    this.counter += 1;
    return `00000000-0000-7000-8000-${String(this.counter).padStart(12, "0")}`;
  }
}

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; fields: object; message: string | undefined }> = [];
  info(fields: object, message?: string): void {
    this.lines.push({ level: "info", fields, message });
  }
  warn(fields: object, message?: string): void {
    this.lines.push({ level: "warn", fields, message });
  }
  error(fields: object, message?: string): void {
    this.lines.push({ level: "error", fields, message });
  }
}

export const caller = (userId = "user-1", n = 1): Caller => ({
  userId,
  correlationId: `corr-${n}`,
  causationId: `req-${n}`,
});

export const TENANT_A = "018f3c1e-7a00-7000-8000-0000000000aa";
export const TENANT_B = "018f3c1e-7a00-7000-8000-0000000000bb";

/** The caller of a money use case: a user of a tenant. */
export const who = (userId = "user-1", tenantId = TENANT_A, n = 1) => ({ ...caller(userId, n), tenantId });

/** The force-payout-failure flag, flipped by a test. */
export class TestSettings implements RuntimeSettings {
  force = false;
  forcePayoutFailure(): boolean {
    return this.force;
  }
}

export const WEBHOOK_SECRET = "whsec_test_secret_value";
export const CHECKOUT = { successUrl: "https://app.example/deposits/success", cancelUrl: "https://app.example/deposits/cancelled" };

/** The in-memory adapters, the fake provider and the fake trading the use cases run over. */
export function createCore() {
  const store = new MemoryStore();
  const clock = new TestClock();
  const ids = new SequentialIds();
  const logger = new RecordingLogger();
  const provider = new FakePaymentProvider({ now: () => clock.now() });
  const trading = new FakeTrading();
  const settings = new TestSettings();
  const deps: PaymentsDeps = { store, clock, ids, logger, provider, trading, settings, checkout: CHECKOUT };
  return { store, clock, ids, logger, provider, trading, settings, deps };
}

/** A tenant with a schema, as if its TenantCreated event had been processed. */
export async function provisionTenants(core: Pick<ReturnType<typeof createCore>, "store" | "clock">, ...tenantIds: string[]): Promise<void> {
  for (const tenantId of tenantIds) await core.store.repositories.tenants.provision(tenantId, core.clock.now());
}

/**
 * Routes that exist only in tests: they exercise the guards and the error mapping of the web layer before the real
 * routes exist. They are registered on the application before it is ready.
 */
export function addProbeRoutes(app: FastifyInstance, auth: AuthOptions): void {
  const onRequest = authenticate(auth);
  app.get("/_probe/whoami", { onRequest }, (request) => ({ userId: requireAuth(request).userId }));
  app.get("/_probe/me", { onRequest }, (request) => requireTenantUser(request));
  app.get("/_probe/unavailable", { onRequest }, () => {
    throw new Unavailable("provider_unavailable", "The payment provider is down", 7);
  });
  app.get("/_probe/conflict", { onRequest }, () => {
    throw new Conflict("idempotency_key_reused", "The key was used with another body");
  });
  app.get("/_probe/not-found", { onRequest }, () => {
    throw new NotFound("deposit_not_found", "Deposit not found");
  });
  app.get("/_probe/invalid", { onRequest }, () => {
    throw new ValidationFailed([{ field: "amount", message: "is required" }]);
  });
  app.get("/_probe/amount", { onRequest }, (request) => guardDomain(() => parseAmount((request.query as { amount?: string }).amount === undefined ? 0 : Number((request.query as { amount?: string }).amount))));
  app.get("/_probe/boom", { onRequest }, () => {
    throw new Error("something unexpected");
  });
}

/** The whole web application over the in-memory adapters, with real JWT verification against a local key. */
export async function createHarness(options: { probes?: boolean; metrics?: WebDeps["metrics"] } = {}) {
  const core = createCore();
  await provisionTenants(core, TENANT_A, TENANT_B);
  const useCases = createUseCases(core.deps);
  const keys = await createTestKeys();
  const logLines: string[] = [];
  // The key resolver can be made to fail like a JWKS download that does not work (see failKeys).
  let keyFailure: unknown = null;
  const getKey: JWTVerifyGetKey = async (header, token) => {
    // Tests also reject with things that are no Error (a string), as a misbehaving key resolver could.
    if (keyFailure !== null) throw keyFailure as Error;
    return await keys.getKey(header, token);
  };
  let draining = false;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString("utf8"));
      callback();
    },
  });
  const auth: AuthOptions = { issuer: ISSUER, audience: AUDIENCE, getKey, rolesClaim: "realm_access.roles", tenantClaim: "organization" };
  const app = buildApp({
    logger: createLogger("info", sink),
    auth,
    health: { ping: () => core.store.ping(), isDraining: () => draining },
    useCases,
    webhook: { secret: WEBHOOK_SECRET, nowSeconds: () => Math.floor(core.clock.now().getTime() / 1000) },
    metrics: options.metrics,
  });
  if (options.probes) addProbeRoutes(app, auth);
  await app.ready();

  /** Authorization header for a token with the given claims. */
  async function bearer(tokenOptions?: Parameters<typeof keys.sign>[0]) {
    return { authorization: `Bearer ${await keys.sign(tokenOptions)}` };
  }

  /** From now on the key resolver rejects with this error; null makes it work again. */
  const failKeys = (error: unknown): void => {
    keyFailure = error;
  };
  /** Pretends the process got SIGTERM and is in the drain delay (or is running again). */
  const setDraining = (value: boolean): void => {
    draining = value;
  };

  /** Posts a webhook body signed with the shared secret; `secret`, `offsetSeconds` and `header` break it on purpose. */
  async function webhook(body: unknown, options: { secret?: string; offsetSeconds?: number; header?: string | null; raw?: string } = {}) {
    const raw = options.raw ?? JSON.stringify(body);
    const timestamp = String(Math.floor(core.clock.now().getTime() / 1000) + (options.offsetSeconds ?? 0));
    const header = options.header === undefined ? `t=${timestamp},v1=${signWebhook(options.secret ?? WEBHOOK_SECRET, timestamp, raw).toString("hex")}` : options.header;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (header !== null) headers["provider-signature"] = header;
    return app.inject({ method: "POST", url: "/v1/webhooks/payment-provider", headers, payload: raw });
  }

  const publisher = new MemoryEventPublisher();
  return { ...core, app, keys, bearer, logLines, publisher, failKeys, setDraining, useCases, webhook };
}
