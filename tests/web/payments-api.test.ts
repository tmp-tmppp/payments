import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaymentProviderUnavailable } from "../../src/usecases/errors.js";
import { createUseCases } from "../../src/usecases/application.js";
import { sendPayouts } from "../../src/usecases/jobs.js";
import { createLogger } from "../../src/logger.js";
import { buildApp } from "../../src/web/app.js";
import { responseErrors } from "../support/contracts.js";
import { TENANT_A, TENANT_B, createCore, createHarness } from "../support/harness.js";

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.app.close();
});

const PROBLEM = "application/problem+json";
const trader = (overrides: Record<string, unknown> = {}) => ({ roles: ["trader"], organization: [TENANT_A], sub: "user-1", ...overrides });

async function send(method: "GET" | "POST", url: string, options: { token?: Record<string, unknown> | null; key?: string | null; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = options.token === null ? {} : { ...(await h.bearer(options.token ?? trader())) };
  if (options.key !== null && method === "POST") headers["idempotency-key"] = options.key ?? "key-1";
  if (method === "POST") headers["content-type"] = "application/json";
  const response = await h.app.inject({ method, url, headers, payload: options.raw ?? (method === "POST" ? JSON.stringify(options.body ?? { amount: 2500 }) : undefined) });
  return { status: response.statusCode, headers: response.headers, body: response.json<Record<string, any>>() };
}

describe("POST /v1/deposits", () => {
  it("makes a deposit: 201 with the checkout link and a status link, in the shape of the contract", async () => {
    const response = await send("POST", "/v1/deposits");
    expect(response.status).toBe(201);
    expect(response.headers["location"]).toBe(`/v1/deposits/${response.body["id"]}`);
    expect(response.body).toMatchObject({ status: "pending", amount: 2500, userId: "user-1", failureReason: null, completedAt: null });
    expect(response.body["checkoutUrl"]).toMatch(/^http/);
    expect(response.body).not.toHaveProperty("tenantId");
    expect(response.body).not.toHaveProperty("requestHash");
    expect(responseErrors("/v1/deposits", "post", 201, response.body)).toEqual([]);
    // The return URLs are the fixed ones; the buyer cannot choose them.
    expect(h.provider.sessionList()[0]?.metadata).toEqual({ tenantId: TENANT_A, depositId: response.body["id"] });
  });

  it("answers 200 with the same deposit for the same key and body, and 409 for the same key with another body", async () => {
    const first = await send("POST", "/v1/deposits");
    const again = await send("POST", "/v1/deposits");
    expect(again.status).toBe(200);
    expect(again.body["id"]).toBe(first.body["id"]);
    expect(responseErrors("/v1/deposits", "post", 200, again.body)).toEqual([]);

    const other = await send("POST", "/v1/deposits", { body: { amount: 2600 } });
    expect(other.status).toBe(409);
    expect(other.headers["content-type"]).toContain(PROBLEM);
    expect(other.body).toMatchObject({ code: "idempotency_key_reused", status: 409 });
    expect(responseErrors("/v1/deposits", "post", 409, other.body)).toEqual([]);
  });

  it("is allowed to a tenant admin too", async () => {
    expect((await send("POST", "/v1/deposits", { token: trader({ roles: ["tenant-admin"] }) })).status).toBe(201);
  });

  it.each([
    ["no Idempotency-Key", { key: null }, "Idempotency-Key"],
    ["a malformed Idempotency-Key", { key: "has space" }, "Idempotency-Key"],
    ["an amount of 0", { body: { amount: 0 } }, "amount"],
    ["an amount over the limit", { body: { amount: 1_000_001 } }, "amount"],
    ["an amount that is text", { body: { amount: "2500" } }, "amount"],
    ["an amount with decimals", { body: { amount: 12.5 } }, "amount"],
    ["no amount", { body: {} }, "amount"],
    ["return URLs in the body", { body: { amount: 500, successUrl: "https://evil.example" } }, "successUrl"],
    ["a tenant in the body", { body: { amount: 500, tenantId: TENANT_B } }, "tenantId"],
    ["a body that is no object", { body: [500] }, "body"],
  ] as const)("refuses %s with a 400 that names the field", async (_name, options, field) => {
    const response = await send("POST", "/v1/deposits", options);
    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toContain(PROBLEM);
    expect(response.body["errors"].map((error: { field: string }) => error.field)).toContain(field);
    expect(responseErrors("/v1/deposits", "post", 400, response.body)).toEqual([]);
    expect(h.provider.calls).toEqual([]);
  });

  it("refuses a body that is not JSON, and an empty one", async () => {
    expect((await send("POST", "/v1/deposits", { raw: "{amount" })).status).toBe(400);
    expect((await send("POST", "/v1/deposits", { raw: "" })).status).toBe(400);
  });

  it("answers 401 without a token and 403 without the role or the tenant, before it looks at the body", async () => {
    expect((await send("POST", "/v1/deposits", { token: null })).status).toBe(401);
    for (const token of [trader({ roles: [] }), trader({ roles: ["viewer"] }), trader({ organization: null }), trader({ organization: ["acme"] })]) {
      const response = await send("POST", "/v1/deposits", { token, body: { nonsense: true }, key: null });
      expect(response.status).toBe(403);
      expect(responseErrors("/v1/deposits", "post", 403, response.body)).toEqual([]);
    }
  });

  it("takes the tenant only from the token: another tenant's deposit is made in that tenant's schema", async () => {
    await send("POST", "/v1/deposits", { token: trader({ organization: [TENANT_B] }) });
    const snapshot = h.store.snapshot();
    expect(snapshot.tenants.get(TENANT_A)?.deposits).toEqual([]);
    expect(snapshot.tenants.get(TENANT_B)?.deposits).toHaveLength(1);
  });

  it("answers 503 tenant_not_ready with Retry-After for a tenant whose schema does not exist yet", async () => {
    const response = await send("POST", "/v1/deposits", { token: trader({ organization: ["018f3c1e-7a00-7000-8000-0000000000cc"] }) });
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.body["code"]).toBe("tenant_not_ready");
    expect(responseErrors("/v1/deposits", "post", 503, response.body)).toEqual([]);
  });

  it("answers 503 provider_unavailable with Retry-After when the provider is down; the deposit waits without a session", async () => {
    h.provider.failNext(new PaymentProviderUnavailable("circuit open"));
    const response = await send("POST", "/v1/deposits");
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("10");
    expect(response.body["code"]).toBe("provider_unavailable");
    expect(h.store.snapshot().tenants.get(TENANT_A)?.deposits).toMatchObject([{ status: "pending", providerSessionId: null }]);
  });
});

describe("GET /v1/deposits/{id}", () => {
  it("returns the caller's own deposit, in its state now", async () => {
    const made = await send("POST", "/v1/deposits");
    const sessionId = h.provider.sessionList()[0]?.id as string;
    h.provider.pay(sessionId);
    expect((await send("GET", `/v1/deposits/${made.body["id"]}`)).body["status"]).toBe("pending");
    const webhook = await h.webhook({ id: "evt_1", type: "checkout.session.completed", created: "2026-11-01T10:00:00Z", data: { object: "checkout_session", id: sessionId } });
    expect(webhook.json()).toEqual({ status: "processed" });
    const response = await send("GET", `/v1/deposits/${made.body["id"]}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "succeeded" });
    expect(responseErrors("/v1/deposits/{id}", "get", 200, response.body)).toEqual([]);
  });

  it("answers 404 for another user's deposit, another tenant's deposit and an unknown id, and 400 for a bad id", async () => {
    const made = await send("POST", "/v1/deposits");
    const url = `/v1/deposits/${made.body["id"]}`;
    for (const token of [trader({ sub: "user-2" }), trader({ organization: [TENANT_B] })]) {
      const response = await send("GET", url, { token });
      expect(response.status).toBe(404);
      expect(responseErrors("/v1/deposits/{id}", "get", 404, response.body)).toEqual([]);
    }
    expect((await send("GET", "/v1/deposits/018f3c1e-7a00-7000-8000-000000000999")).status).toBe(404);
    expect((await send("GET", "/v1/deposits/not-a-uuid")).status).toBe(400);
    expect((await send("GET", url, { token: null })).status).toBe(401);
    expect((await send("GET", url, { token: trader({ roles: [] }) })).status).toBe(403);
  });
});

describe("POST /v1/withdrawals", () => {
  it("accepts a withdrawal that trading debited: 202 with the status link", async () => {
    const response = await send("POST", "/v1/withdrawals", { body: { amount: 1800 } });
    expect(response.status).toBe(202);
    expect(response.headers["location"]).toBe(`/v1/withdrawals/${response.body["id"]}`);
    expect(response.body).toMatchObject({ status: "debited", amount: 1800, reason: null });
    expect(responseErrors("/v1/withdrawals", "post", 202, response.body)).toEqual([]);
  });

  it("answers 409 insufficient_credits with the withdrawal's id and link when trading says the credits are too few, and again for a repeat", async () => {
    h.trading.setCredits(TENANT_A, "user-1", 10);
    const response = await send("POST", "/v1/withdrawals", { body: { amount: 1800 } });
    expect(response.status).toBe(409);
    expect(response.headers["content-type"]).toContain(PROBLEM);
    expect(response.body).toMatchObject({ code: "insufficient_credits", status: 409 });
    expect(response.headers["location"]).toBe(`/v1/withdrawals/${response.body["withdrawalId"]}`);
    expect(responseErrors("/v1/withdrawals", "post", 409, response.body)).toEqual([]);

    const again = await send("POST", "/v1/withdrawals", { body: { amount: 1800 } });
    expect(again.status).toBe(409);
    expect(again.body["withdrawalId"]).toBe(response.body["withdrawalId"]);
    const stored = await send("GET", `/v1/withdrawals/${response.body["withdrawalId"]}`);
    expect(stored.body).toMatchObject({ status: "rejected", reason: "insufficient_credits", amount: 1800 });
  });

  it("answers 503 trading_unavailable with Retry-After when the circuit was open before any call", async () => {
    h.trading.answerNext({ kind: "circuit_open" });
    const response = await send("POST", "/v1/withdrawals", { body: { amount: 1800 } });
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("10");
    expect(response.body).toMatchObject({ code: "trading_unavailable" });
    expect(response.headers["location"]).toBe(`/v1/withdrawals/${response.body["withdrawalId"]}`);
    expect(responseErrors("/v1/withdrawals", "post", 503, response.body)).toEqual([]);
  });

  it("answers 202 with the withdrawal still requested when the answer of trading was lost", async () => {
    h.trading.loseNextAnswers(1);
    const response = await send("POST", "/v1/withdrawals", { body: { amount: 1800 } });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "requested" });
    expect(responseErrors("/v1/withdrawals", "post", 202, response.body)).toEqual([]);
  });

  it("repeats a request: 202 while it is running, 200 once it has ended, 409 for another body", async () => {
    const first = await send("POST", "/v1/withdrawals", { body: { amount: 1800 } });
    const running = await send("POST", "/v1/withdrawals", { body: { amount: 1800 } });
    expect(running.status).toBe(202);
    expect(running.body["id"]).toBe(first.body["id"]);

    await sendPayouts(h.deps, 10);
    h.provider.settlePayouts();
    h.clock.advanceMs(11_000);
    await sendPayouts(h.deps, 10);
    const ended = await send("POST", "/v1/withdrawals", { body: { amount: 1800 } });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ id: first.body["id"], status: "paid_out" });
    expect(responseErrors("/v1/withdrawals", "post", 200, ended.body)).toEqual([]);

    expect((await send("POST", "/v1/withdrawals", { body: { amount: 1801 } })).status).toBe(409);
  });

  it("checks the token, the role, the key and the amount like the deposit route", async () => {
    expect((await send("POST", "/v1/withdrawals", { token: null })).status).toBe(401);
    expect((await send("POST", "/v1/withdrawals", { token: trader({ roles: ["viewer"] }) })).status).toBe(403);
    expect((await send("POST", "/v1/withdrawals", { key: null })).status).toBe(400);
    expect((await send("POST", "/v1/withdrawals", { body: { amount: -1 } })).status).toBe(400);
    expect(h.trading.requests).toEqual([]);
  });
});

describe("GET /v1/withdrawals/{id}", () => {
  it("returns the caller's own withdrawal and hides everyone else's", async () => {
    const made = await send("POST", "/v1/withdrawals", { body: { amount: 1800 } });
    const url = `/v1/withdrawals/${made.body["id"]}`;
    const own = await send("GET", url);
    expect(own.status).toBe(200);
    expect(responseErrors("/v1/withdrawals/{id}", "get", 200, own.body)).toEqual([]);
    expect((await send("GET", url, { token: trader({ sub: "user-2" }) })).status).toBe(404);
    expect((await send("GET", url, { token: trader({ organization: [TENANT_B] }) })).status).toBe(404);
    expect((await send("GET", "/v1/withdrawals/not-a-uuid")).status).toBe(400);
  });
});

describe("POST /v1/webhooks/payment-provider", () => {
  const body = (sessionId: string, id = "evt_1") => ({ id, type: "checkout.session.completed", created: "2026-11-01T10:00:00Z", data: { object: "checkout_session", id: sessionId } });

  async function paidSession() {
    await send("POST", "/v1/deposits");
    const sessionId = h.provider.sessionList()[0]?.id as string;
    h.provider.pay(sessionId);
    return sessionId;
  }

  it("needs no user token, only the signature: processed, then duplicate", async () => {
    const sessionId = await paidSession();
    const first = await h.webhook(body(sessionId));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: "processed" });
    expect(responseErrors("/v1/webhooks/payment-provider", "post", 200, first.json())).toEqual([]);
    expect((await h.webhook(body(sessionId))).json()).toEqual({ status: "duplicate" });
    expect(h.store.snapshot().outbox).toHaveLength(1);
  });

  it("answers ignored for an event about an object it does not know", async () => {
    expect((await h.webhook(body("cs_unknown"))).json()).toEqual({ status: "ignored" });
  });

  it.each([
    ["a wrong secret", { secret: "whsec_other" }],
    ["a timestamp from the past", { offsetSeconds: -301 }],
    ["a timestamp from the future", { offsetSeconds: 301 }],
    ["no signature header", { header: null }],
    ["a malformed signature header", { header: "nonsense" }],
  ])("refuses %s with a 401 and changes nothing", async (_name, options) => {
    const sessionId = await paidSession();
    const response = await h.webhook(body(sessionId), options);
    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain(PROBLEM);
    expect(response.headers["www-authenticate"]).toBeUndefined();
    expect(response.json()).toMatchObject({ code: "invalid_signature" });
    expect(responseErrors("/v1/webhooks/payment-provider", "post", 401, response.json())).toEqual([]);
    expect(h.store.snapshot().providerEvents).toEqual([]);
  });

  it("accepts a header with several v1 entries when one of them is right", async () => {
    const sessionId = await paidSession();
    const raw = JSON.stringify(body(sessionId));
    const [timestamp, signature] = (await signedHeader(raw)).split(",");
    const response = await h.webhook(null, { raw, header: `${timestamp},v1=${"0".repeat(64)},${signature}` });
    expect(response.statusCode).toBe(200);
  });

  it("checks the signature over the body exactly as received, not over a re-serialized copy", async () => {
    const sessionId = await paidSession();
    const spaced = `{ "id": "evt_9",  "type": "checkout.session.completed", "created": "2026-11-01T10:00:00Z", "data": { "object": "checkout_session", "id": "${sessionId}" } }`;
    expect((await h.webhook(null, { raw: spaced })).statusCode).toBe(200);
    const tampered = await h.webhook(null, { raw: spaced, header: (await signedHeader(spaced)).replace(/v1=[0-9a-f]/, "v1=0") });
    expect(tampered.statusCode).toBe(401);
  });

  it.each([
    ["not JSON", { raw: "{nope" }],
    ["not an object", { raw: "[1]" }],
    ["without an id", { raw: JSON.stringify({ type: "x", data: { object: "payout", id: "po_1" } }) }],
    ["about an unknown kind of object", { raw: JSON.stringify({ id: "evt_2", type: "x", data: { object: "customer", id: "c1" } }) }],
    ["without an object id", { raw: JSON.stringify({ id: "evt_2", type: "x", data: { object: "payout" } }) }],
    // JSON.stringify writes a lone surrogate as the escape "\ud800" and NUL as "\u0000", as a sender on the wire would.
    ["with a NUL in its id", { raw: JSON.stringify({ id: "evt\u00002", type: "x", data: { object: "payout", id: "po_1" } }) }],
    ["with a lone surrogate in its type", { raw: JSON.stringify({ id: "evt_2", type: "x\ud800", data: { object: "payout", id: "po_1" } }) }],
    ["with a lone surrogate in its object id", { raw: JSON.stringify({ id: "evt_2", type: "x", data: { object: "payout", id: "po_\udc00" } }) }],
  ])("answers 400 for a signed body that is %s", async (_name, options) => {
    const response = await h.webhook(null, options);
    expect(response.statusCode).toBe(400);
    expect(response.json()["code"]).toBe("validation_failed");
    expect(responseErrors("/v1/webhooks/payment-provider", "post", 400, response.json())).toEqual([]);
  });

  it("answers 503 with Retry-After when the provider cannot be read back, so that the provider delivers again", async () => {
    const sessionId = await paidSession();
    h.provider.failNext(new PaymentProviderUnavailable("down"));
    const response = await h.webhook(body(sessionId));
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("10");
    expect((await h.webhook(body(sessionId))).json()).toEqual({ status: "processed" });
  });

  it("refuses every webhook when no secret is configured (a local run without a provider)", async () => {
    const core = createCore();
    const app = buildApp({
      logger: createLogger("silent", new Writable({ write: (_chunk, _encoding, callback) => callback() })),
      auth: { issuer: "i", audience: "a", getKey: () => Promise.reject(new Error("no keys")), rolesClaim: "r", tenantClaim: "o" },
      health: { ping: () => Promise.resolve(), isDraining: () => false },
      useCases: createUseCases(core.deps),
      webhook: { secret: null, nowSeconds: () => 0 },
    });
    const response = await app.inject({ method: "POST", url: "/v1/webhooks/payment-provider", headers: { "content-type": "application/json", "provider-signature": "t=0,v1=" + "0".repeat(64) }, payload: "{}" });
    await app.close();
    expect(response.statusCode).toBe(401);
  });

  it("reads other routes' JSON as before: the raw-body parser stays inside the webhook's scope", async () => {
    expect((await send("POST", "/v1/deposits", { body: { amount: 100 } })).status).toBe(201);
  });
});

async function signedHeader(raw: string): Promise<string> {
  const { signWebhook } = await import("../../src/domain/webhook-signature.js");
  const { WEBHOOK_SECRET } = await import("../support/harness.js");
  const timestamp = String(Math.floor(h.clock.now().getTime() / 1000));
  return `t=${timestamp},v1=${signWebhook(WEBHOOK_SECRET, timestamp, raw).toString("hex")}`;
}
