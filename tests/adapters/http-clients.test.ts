import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClientCredentialsTokenSource } from "../../src/adapters/keycloak/client-credentials-token.js";
import { PaymentProviderClient } from "../../src/adapters/provider/payment-provider-client.js";
import { TradingClient } from "../../src/adapters/trading/trading-client.js";
import { PaymentProviderKeyReused, PaymentProviderRejected, PaymentProviderUnavailable } from "../../src/usecases/errors.js";
import { TENANT_A } from "../support/harness.js";

interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Handler = (request: Recorded, respond: (status: number, body?: unknown, headers?: Record<string, string>) => void) => void | Promise<void>;

/** A small HTTP server whose answers each test decides, like the template's fake Keycloak. */
class StubServer {
  readonly requests: Recorded[] = [];
  handler: Handler = (_request, respond) => respond(404, { code: "unknown" });
  url = "";
  private server: Server = createServer((req, res) => void this.handle(req, res));

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
    this.handler = (_request, respond) => respond(404, { code: "unknown" });
  }

  count(method: string, path: RegExp): number {
    return this.requests.filter((request) => request.method === method && path.test(request.path)).length;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const recorded: Recorded = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    this.requests.push(recorded);
    await this.handler(recorded, (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}

/** Fast resilience settings: three attempts with waits of a few milliseconds. */
const FAST = { timeoutMs: 400, maxAttempts: 3, retryInitialDelayMs: 1, retryMaxDelayMs: 5 } as const;
const API_KEY = "test-api-key-not-a-secret";
const DEPOSIT = "018f3c1e-7a00-7000-8000-000000000001";
const WITHDRAWAL = "018f3c1e-7a00-7000-8000-000000000002";
const SESSION_ID = "cs_YmF6cXV4YmF6cXV4YmF6cXV4";
const PAYOUT_ID = "po_YmF6cXV4YmF6cXV4YmF6cXV4";

const sessionBody = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  object: "checkout_session",
  url: `http://provider.example/checkout/${SESSION_ID}`,
  status: "open",
  amount: 500,
  currency: "EUR",
  metadata: { tenantId: TENANT_A, depositId: DEPOSIT },
  successUrl: "https://app.example/ok",
  cancelUrl: "https://app.example/no",
  createdAt: "2026-11-01T10:00:00.000Z",
  expiresAt: "2026-11-01T10:30:00.000Z",
  ...overrides,
});
const payoutBody = (overrides: Record<string, unknown> = {}) => ({
  id: PAYOUT_ID,
  object: "payout",
  status: "pending",
  amount: 300,
  currency: "EUR",
  destination: "user-1",
  metadata: { tenantId: TENANT_A, withdrawalId: WITHDRAWAL },
  failureReason: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  settledAt: null,
  ...overrides,
});

/** The address of a server that was stopped: a connection to it is refused. */
async function closedUrl(): Promise<string> {
  const stub = new StubServer();
  await stub.start();
  const { url } = stub;
  await stub.stop();
  return url;
}

describe("PaymentProviderClient", () => {
  const server = new StubServer();
  beforeAll(() => server.start());
  afterAll(() => server.stop());
  beforeEach(() => server.reset());

  const client = (overrides: Partial<ConstructorParameters<typeof PaymentProviderClient>[0]> = {}) =>
    new PaymentProviderClient({ baseUrl: server.url, apiKey: API_KEY, ...FAST, ...overrides });
  const checkout = { depositId: DEPOSIT, tenantId: TENANT_A, amount: 500, successUrl: "https://app.example/ok", cancelUrl: "https://app.example/no" };
  const payout = { withdrawalId: WITHDRAWAL, tenantId: TENANT_A, userId: "user-1", amount: 300 };

  it("reads the session's own end, and null when the provider sent none or a bad date", async () => {
    server.handler = (_request, respond) => respond(200, sessionBody({ expiresAt: "not a date" }));
    expect((await client().getCheckoutSession(SESSION_ID))?.expiresAt).toBeNull();
    server.handler = (_request, respond) => respond(200, sessionBody({ expiresAt: undefined }));
    expect((await client().getCheckoutSession(SESSION_ID))?.expiresAt).toBeNull();
  });

  it("creates a checkout session with the key, the deposit id as Idempotency-Key and only the fixed return URLs", async () => {
    server.handler = (_request, respond) => respond(201, sessionBody());
    const session = await client().createCheckoutSession(checkout);
    expect(session).toEqual({
      id: SESSION_ID,
      url: `http://provider.example/checkout/${SESSION_ID}`,
      status: "open",
      amount: 500,
      expiresAt: new Date("2026-11-01T10:30:00.000Z"),
      metadata: { tenantId: TENANT_A, depositId: DEPOSIT },
    });
    const [request] = server.requests;
    expect(request).toMatchObject({ method: "POST", path: "/v1/checkout-sessions" });
    expect(request?.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(request?.headers["idempotency-key"]).toBe(DEPOSIT);
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request?.body ?? "")).toEqual({
      amount: 500,
      currency: "EUR",
      metadata: { tenantId: TENANT_A, depositId: DEPOSIT },
      successUrl: "https://app.example/ok",
      cancelUrl: "https://app.example/no",
    });
  });

  it("takes the 200 of a replayed key like the 201 of the first call", async () => {
    server.handler = (_request, respond) => respond(200, sessionBody({ status: "completed" }));
    expect((await client().createCheckoutSession(checkout)).status).toBe("completed");
  });

  it("reads a session back, URL-encoding the id, and answers null for a 404", async () => {
    server.handler = (request, respond) => (request.path === `/v1/checkout-sessions/${SESSION_ID}` ? respond(200, sessionBody({ status: "declined" })) : respond(404, { code: "not_found" }));
    expect((await client().getCheckoutSession(SESSION_ID))?.status).toBe("declined");
    expect(await client().getCheckoutSession("cs_gone")).toBeNull();
    server.handler = (_request, respond) => respond(404, { code: "not_found" });
    await client().getCheckoutSession("a/b ?x");
    expect(server.requests.at(-1)?.path).toBe("/v1/checkout-sessions/a%2Fb%20%3Fx");
    expect(server.requests.at(-1)?.headers["idempotency-key"]).toBeUndefined();
  });

  it("creates a payout with the withdrawal id as key and the user id as destination", async () => {
    server.handler = (_request, respond) => respond(201, payoutBody());
    expect(await client().createPayout(payout)).toEqual({ id: PAYOUT_ID, status: "pending", amount: 300, destination: "user-1", metadata: { tenantId: TENANT_A, withdrawalId: WITHDRAWAL }, failureReason: null });
    const [request] = server.requests;
    expect(request?.headers["idempotency-key"]).toBe(WITHDRAWAL);
    expect(JSON.parse(request?.body ?? "")).toEqual({ amount: 300, currency: "EUR", destination: "user-1", metadata: { tenantId: TENANT_A, withdrawalId: WITHDRAWAL } });
  });

  it("reads a payout back: paid, failed with its reason, and null (lost) for a 404", async () => {
    server.handler = (_request, respond) => respond(200, payoutBody({ status: "failed", failureReason: "declined", settledAt: "2026-11-01T10:00:02.000Z" }));
    expect(await client().getPayout(PAYOUT_ID)).toMatchObject({ status: "failed", failureReason: "declined" });
    server.handler = (_request, respond) => respond(200, payoutBody({ status: "paid" }));
    expect((await client().getPayout(PAYOUT_ID))?.status).toBe("paid");
    server.handler = (_request, respond) => respond(404, { code: "not_found" });
    expect(await client().getPayout(PAYOUT_ID)).toBeNull();
  });

  it("maps 409 idempotency_key_reused to its own error and any other 409 to a rejection", async () => {
    server.handler = (_request, respond) => respond(409, { code: "idempotency_key_reused", detail: "another body" });
    const reused = await client().createPayout(payout).catch((error: unknown) => error);
    expect(reused).toBeInstanceOf(PaymentProviderKeyReused);
    expect(reused).toBeInstanceOf(PaymentProviderRejected);
    expect(server.requests).toHaveLength(1);
    server.handler = (_request, respond) => respond(409, { code: "something_else" });
    const other = await client().createPayout(payout).catch((error: unknown) => error);
    expect(other).toBeInstanceOf(PaymentProviderRejected);
    expect(other).not.toBeInstanceOf(PaymentProviderKeyReused);
    expect(other).toMatchObject({ status: 409, code: "something_else" });
  });

  it.each([400, 401, 403, 413, 415])("maps %i to a rejection that carries the status and the code, without a retry", async (status) => {
    server.handler = (_request, respond) => respond(status, { code: "bad_thing", detail: "why" });
    const error = await client().createCheckoutSession(checkout).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentProviderRejected);
    expect(error).toMatchObject({ status, code: "bad_thing" });
    expect(server.requests).toHaveLength(1);
  });

  it("never puts the API key into an error", async () => {
    server.handler = (_request, respond) => respond(401, { code: "unauthorized", detail: "bad key" });
    const error = (await client().getPayout(PAYOUT_ID).catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain(API_KEY);
    expect(String(error.cause)).not.toContain(API_KEY);
  });

  it("retries 5xx and 429 with the same key, and succeeds when a later attempt does", async () => {
    let calls = 0;
    server.handler = (_request, respond) => {
      calls += 1;
      if (calls === 1) return respond(503, { code: "capacity_exceeded" }, { "retry-after": "60" });
      if (calls === 2) return respond(429, { code: "rate_limited" });
      respond(201, payoutBody());
    };
    expect((await client().createPayout(payout)).id).toBe(PAYOUT_ID);
    expect(server.requests.map((request) => request.headers["idempotency-key"])).toEqual([WITHDRAWAL, WITHDRAWAL, WITHDRAWAL]);
  });

  it("says unavailable when every attempt fails: 5xx, a refused connection, a call that never answers", async () => {
    server.handler = (_request, respond) => respond(500, { code: "boom" });
    await expect(client().getPayout(PAYOUT_ID)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    expect(server.requests).toHaveLength(3);
    await expect(client({ baseUrl: await closedUrl() }).getPayout(PAYOUT_ID)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    server.reset();
    server.handler = () => undefined;
    await expect(client({ timeoutMs: 60, maxAttempts: 2 }).getPayout(PAYOUT_ID)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    expect(server.requests).toHaveLength(2);
  });

  it("opens the circuit after consecutive failures and then fails fast without sending", async () => {
    server.handler = (_request, respond) => respond(500, {});
    const fragile = client({ maxAttempts: 1, breakerThreshold: 2, halfOpenAfterMs: 60_000 });
    await expect(fragile.getPayout(PAYOUT_ID)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    await expect(fragile.getPayout(PAYOUT_ID)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    expect(server.requests).toHaveLength(2);
    await expect(fragile.getPayout(PAYOUT_ID)).rejects.toThrow("unavailable");
    expect(server.requests).toHaveLength(2);
  });

  it("treats an answer that is not the documented object as unavailable, not as a result", async () => {
    server.handler = (_request, respond) => respond(200, { hello: "world" });
    await expect(client().getCheckoutSession(SESSION_ID)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    server.handler = (_request, respond) => respond(200, payoutBody({ status: "mystery" }));
    await expect(client().getPayout(PAYOUT_ID)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    server.handler = (_request, respond) => respond(200, [1, 2]);
    await expect(client().createPayout(payout)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
  });

  it("treats an id, URL or destination PostgreSQL cannot store (a NUL, a lone surrogate) as unavailable", async () => {
    server.handler = (_request, respond) => respond(200, sessionBody({ id: "cs_\u00001" }));
    await expect(client().getCheckoutSession(SESSION_ID)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    server.handler = (_request, respond) => respond(200, sessionBody({ url: "https://pay.example/\ud800" }));
    await expect(client().getCheckoutSession(SESSION_ID)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    server.handler = (_request, respond) => respond(200, payoutBody({ id: "po_\udc00" }));
    await expect(client().getPayout(PAYOUT_ID)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    server.handler = (_request, respond) => respond(200, payoutBody({ destination: "user\u0000" }));
    await expect(client().getPayout(PAYOUT_ID)).rejects.toBeInstanceOf(PaymentProviderUnavailable);
    server.handler = (_request, respond) => respond(200, sessionBody({ url: "https://pay.example/😀" }));
    expect((await client().getCheckoutSession(SESSION_ID))?.url).toBe("https://pay.example/😀");
  });

  it("ignores metadata values that are not text", async () => {
    server.handler = (_request, respond) => respond(200, sessionBody({ metadata: { tenantId: TENANT_A, n: 5 } }));
    expect((await client().getCheckoutSession(SESSION_ID))?.metadata).toEqual({ tenantId: TENANT_A });
  });
});

describe("ClientCredentialsTokenSource", () => {
  const server = new StubServer();
  let nowMs = 1_000_000;
  let lifetime = 300;
  beforeAll(() => server.start());
  afterAll(() => server.stop());
  beforeEach(() => {
    server.reset();
    nowMs = 1_000_000;
    lifetime = 300;
    server.handler = (_request, respond) => respond(200, { access_token: `token-${server.requests.length}`, expires_in: lifetime });
  });

  const source = () => new ClientCredentialsTokenSource({ tokenUrl: `${server.url}/realms/chance/protocol/openid-connect/token`, clientId: "payments", clientSecret: "client-secret-for-tests", nowMs: () => nowMs });

  it("asks the realm's token endpoint with the client credentials", async () => {
    expect(await source().getToken()).toBe("token-1");
    const [request] = server.requests;
    expect(request).toMatchObject({ method: "POST", path: "/realms/chance/protocol/openid-connect/token" });
    expect(request?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(request?.body).get("grant_type")).toBe("client_credentials");
    expect(new URLSearchParams(request?.body).get("client_id")).toBe("payments");
  });

  it("caches the token until 30 seconds before it expires, then fetches a new one", async () => {
    const tokens = source();
    await tokens.getToken();
    nowMs += 269_000;
    expect(await tokens.getToken()).toBe("token-1");
    nowMs += 2000;
    expect(await tokens.getToken()).toBe("token-2");
    expect(server.requests).toHaveLength(2);
  });

  it("makes one request for callers that ask at the same time, and a new one after invalidate()", async () => {
    const tokens = source();
    expect(await Promise.all([tokens.getToken(), tokens.getToken(), tokens.getToken()])).toEqual(["token-1", "token-1", "token-1"]);
    expect(server.requests).toHaveLength(1);
    tokens.invalidate();
    expect(await tokens.getToken()).toBe("token-2");
  });

  it("throws what went wrong: the status, a response without a token", async () => {
    server.handler = (_request, respond) => respond(401, { error: "invalid_client" });
    await expect(source().getToken()).rejects.toMatchObject({ name: "HttpStatusError", status: 401 });
    server.handler = (_request, respond) => respond(200, { nothing: true });
    await expect(source().getToken()).rejects.toThrow("no access_token");
  });

  it("assumes 60 seconds when the answer has no expires_in", async () => {
    server.handler = (_request, respond) => respond(200, { access_token: "short" });
    const tokens = source();
    await tokens.getToken();
    nowMs += 31_000;
    await tokens.getToken();
    expect(server.requests).toHaveLength(2);
  });
});

describe("TradingClient", () => {
  const server = new StubServer();
  /** Debits already made, by withdrawal id: the idempotent trading of the contract. */
  const debited = new Set<string>();
  let credits = 1000;
  beforeAll(() => server.start());
  afterAll(() => server.stop());
  afterEach(() => debited.clear());
  beforeEach(() => {
    server.reset();
    debited.clear();
    credits = 1000;
    server.handler = (request, respond) => {
      if (request.path.endsWith("/protocol/openid-connect/token")) return respond(200, { access_token: `svc-${server.count("POST", /openid-connect\/token$/)}`, expires_in: 300 });
      const body = JSON.parse(request.body) as { withdrawalId: string; amount: number };
      if (!debited.has(body.withdrawalId)) {
        if (credits < body.amount) return respond(409, { code: "insufficient_credits" });
        credits -= body.amount;
        debited.add(body.withdrawalId);
      }
      respond(200, { withdrawalId: body.withdrawalId, status: "debited" });
    };
  });

  const debitPath = /\/v1\/internal\/debits$/;
  const request = { withdrawalId: WITHDRAWAL, tenantId: TENANT_A, userId: "user-1", amount: 300 };
  const tokens = () => new ClientCredentialsTokenSource({ tokenUrl: `${server.url}/realms/chance/protocol/openid-connect/token`, clientId: "payments", clientSecret: "client-secret-for-tests" });
  const trading = (overrides: Partial<ConstructorParameters<typeof TradingClient>[0]> = {}) => new TradingClient({ baseUrl: server.url, tokens: tokens(), ...FAST, ...overrides });

  it("debits with the service token and the proposal's body", async () => {
    expect(await trading().debit(request)).toEqual({ kind: "debited" });
    const debit = server.requests.find((recorded) => debitPath.test(recorded.path));
    expect(debit?.method).toBe("POST");
    expect(debit?.headers["authorization"]).toBe("Bearer svc-1");
    expect(debit?.headers["idempotency-key"]).toBe(WITHDRAWAL);
    expect(JSON.parse(debit?.body ?? "")).toEqual({ withdrawalId: WITHDRAWAL, tenantId: TENANT_A, userId: "user-1", amount: 300 });
    expect(credits).toBe(700);
  });

  it("a repeat with the same withdrawal id is debited again as an answer and takes nothing more", async () => {
    const client = trading();
    expect(await client.debit(request)).toEqual({ kind: "debited" });
    expect(await client.debit(request)).toEqual({ kind: "debited" });
    expect(credits).toBe(700);
    expect(server.count("POST", /openid-connect\/token$/)).toBe(1);
  });

  it("409 is insufficient and is not retried", async () => {
    credits = 100;
    expect(await trading().debit(request)).toEqual({ kind: "insufficient" });
    expect(server.count("POST", debitPath)).toBe(1);
  });

  it("a rejected cached token is replaced once; a second 401 is unknown", async () => {
    let rejects = 1;
    const inner = server.handler;
    server.handler = (recorded, respond) => {
      if (debitPath.test(recorded.path) && rejects > 0) {
        rejects -= 1;
        return respond(401, { code: "invalid_token" });
      }
      return inner(recorded, respond);
    };
    expect(await trading().debit(request)).toEqual({ kind: "debited" });
    expect(server.count("POST", /openid-connect\/token$/)).toBe(2);
    rejects = 5;
    const second = await trading().debit({ ...request, withdrawalId: DEPOSIT });
    expect(second.kind).toBe("unknown");
    expect(second).toMatchObject({ reason: expect.stringContaining("401") });
  });

  it("repeats a call that failed with 5xx and gives unknown when every attempt does", async () => {
    let failures = 1;
    const inner = server.handler;
    server.handler = (recorded, respond) => (debitPath.test(recorded.path) && failures-- > 0 ? respond(500, { code: "boom" }) : inner(recorded, respond));
    expect(await trading().debit(request)).toEqual({ kind: "debited" });
    server.handler = (recorded, respond) => (debitPath.test(recorded.path) ? respond(503, { code: "down" }) : inner(recorded, respond));
    const outcome = await trading().debit({ ...request, withdrawalId: DEPOSIT });
    expect(outcome).toMatchObject({ kind: "unknown", reason: expect.stringContaining("503") });
  });

  it("gives unknown for a timeout, a refused connection, a refused token and an answer that is no debit result", async () => {
    const inner = server.handler;
    server.handler = (recorded, respond) => (debitPath.test(recorded.path) ? undefined : inner(recorded, respond));
    expect((await trading({ timeoutMs: 60, maxAttempts: 1 }).debit(request)).kind).toBe("unknown");
    const dead = new TradingClient({ baseUrl: await closedUrl(), tokens: { getToken: () => Promise.resolve("t"), invalidate: () => undefined }, ...FAST });
    expect((await dead.debit(request)).kind).toBe("unknown");
    server.handler = (recorded, respond) => (recorded.path.endsWith("/token") ? respond(503, {}) : inner(recorded, respond));
    server.requests.length = 0;
    expect((await trading().debit(request)).kind).toBe("unknown");
    expect(server.count("POST", debitPath)).toBe(0);
    server.handler = (recorded, respond) => (debitPath.test(recorded.path) ? respond(200, { hello: "world" }) : inner(recorded, respond));
    expect(await trading().debit(request)).toMatchObject({ kind: "unknown", reason: expect.stringContaining("not a debit result") });
  });

  it("gives unknown, without a retry, for a 400 or 403 from trading", async () => {
    const inner = server.handler;
    for (const status of [400, 403]) {
      server.requests.length = 0;
      server.handler = (recorded, respond) => (debitPath.test(recorded.path) ? respond(status, { code: "refused" }) : inner(recorded, respond));
      expect(await trading().debit(request)).toMatchObject({ kind: "unknown", reason: expect.stringContaining(String(status)) });
      expect(server.count("POST", debitPath)).toBe(1);
    }
  });

  it("says circuit_open, and sends nothing, once the circuit is open before the call", async () => {
    const inner = server.handler;
    server.handler = (recorded, respond) => (debitPath.test(recorded.path) ? respond(500, {}) : inner(recorded, respond));
    const fragile = trading({ maxAttempts: 1, breakerThreshold: 2, halfOpenAfterMs: 60_000 });
    expect((await fragile.debit(request)).kind).toBe("unknown");
    expect((await fragile.debit(request)).kind).toBe("unknown");
    const before = server.requests.length;
    expect(await fragile.debit(request)).toEqual({ kind: "circuit_open" });
    expect(server.requests).toHaveLength(before);
  });

  it("a circuit that opens in the middle of a call is unknown: the request had been sent", async () => {
    const inner = server.handler;
    server.handler = (recorded, respond) => (debitPath.test(recorded.path) ? respond(500, {}) : inner(recorded, respond));
    const outcome = await trading({ maxAttempts: 3, breakerThreshold: 2, halfOpenAfterMs: 60_000 }).debit(request);
    expect(outcome.kind).toBe("unknown");
    expect(server.count("POST", debitPath)).toBe(2);
  });
});
