import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AMOUNT_MAX, AMOUNT_MIN } from "../../src/domain/amount.js";
import { DEPOSIT_FAILURE_REASONS, DEPOSIT_STATUSES } from "../../src/domain/deposit.js";
import { natsSubject } from "../../src/domain/events.js";
import type { EventName } from "../../src/domain/events.js";
import { WITHDRAWAL_FAILURE_REASONS, WITHDRAWAL_REJECT_REASONS, WITHDRAWAL_STATUSES } from "../../src/domain/withdrawal.js";
import { asyncapi, openapi, responseErrors, tradingDebit } from "../support/contracts.js";
import { createHarness } from "../support/harness.js";

const METHODS = ["get", "post", "put", "patch", "delete"];
type Operation = { operationId?: string; security?: unknown[]; responses: Record<string, any>; parameters?: Array<{ $ref?: string }>; requestBody?: any };
const operations = (): Array<{ path: string; method: string; operation: Operation }> =>
  Object.entries(openapi["paths"] as Record<string, Record<string, Operation>>).flatMap(([path, item]) =>
    Object.entries(item).filter(([method]) => METHODS.includes(method)).map(([method, operation]) => ({ path, method, operation })),
  );

describe("contracts/openapi.yaml", () => {
  it("documents exactly the routes the application registers", async () => {
    const harness = await createHarness();
    const registered = harness.app.registeredRoutes
      .filter((route) => !["HEAD", "OPTIONS"].includes(route.method))
      .map((route) => `${route.method} ${route.url.replace(/:(\w+)/g, "{$1}")}`)
      .sort();
    const documented = operations().map(({ path, method }) => `${method.toUpperCase()} ${path}`).sort();
    await harness.app.close();

    expect(registered).toEqual(documented);
  });

  it("is OpenAPI 3.1 with a bearer scheme, unique operation ids and resolvable references", () => {
    expect(openapi["openapi"]).toMatch(/^3\.1\./);
    expect(openapi["components"].securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(openapi["security"]).toEqual([{ bearerAuth: [] }]);

    const ids = operations().map(({ operation }) => operation.operationId ?? "");
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    for (const document of [openapi, tradingDebit]) {
      const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((match) => match[1] ?? "");
      for (const ref of refs) {
        const target = ref.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], document);
        expect(target, `reference #/${ref}`).toBeDefined();
      }
    }
  });

  it("leaves only the health probes and the provider webhook without a bearer token", () => {
    const open = operations().filter(({ operation }) => Array.isArray(operation.security) && operation.security.length === 0).map(({ path }) => path);
    expect(open.sort()).toEqual(["/health/live", "/health/ready", "/health/startup", "/v1/webhooks/payment-provider"]);
  });

  it("documents 503 with a Retry-After header on every authenticated operation and on the webhook, through one shared response", () => {
    const shared = openapi["components"].responses.ServiceUnavailable;
    expect(shared.headers["Retry-After"]).toMatchObject({ schema: { type: "integer" } });
    expect(Object.keys(shared.content)).toEqual(["application/problem+json"]);

    const needing = operations().filter(({ path, operation }) => !path.startsWith("/health") || (operation.security ?? []).length > 0);
    expect(needing.map(({ method, path }) => `${method.toUpperCase()} ${path}`).sort()).toEqual([
      "GET /v1/deposits/{id}",
      "GET /v1/withdrawals/{id}",
      "POST /v1/deposits",
      "POST /v1/webhooks/payment-provider",
      "POST /v1/withdrawals",
    ]);
    for (const { path, method, operation } of needing) {
      expect(operation.responses["503"], `${method} ${path}`).toEqual({ $ref: "#/components/responses/ServiceUnavailable" });
    }
  });

  it("documents the problem+json answer of every error status", () => {
    for (const { method, path, operation } of operations()) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status) < 400) continue;
        const resolved = response.$ref ? openapi["components"].responses[String(response.$ref).split("/").pop() ?? ""] : response;
        expect(Object.keys(resolved.content), `${method} ${path} ${status}`).toEqual(["application/problem+json"]);
      }
    }
  });

  it("answers the cases of the plan: 201, 202, 409 (credits, key reuse) and 503 with Retry-After", () => {
    const post = (path: string) => openapi["paths"][path].post.responses as Record<string, unknown>;
    expect(Object.keys(post("/v1/deposits"))).toEqual(expect.arrayContaining(["201", "200", "400", "401", "403", "409", "503"]));
    expect(Object.keys(post("/v1/withdrawals"))).toEqual(expect.arrayContaining(["202", "200", "400", "401", "403", "409", "503"]));
    expect(post("/v1/deposits")["409"]).toEqual({ $ref: "#/components/responses/IdempotencyKeyReused" });
    expect(openapi["paths"]["/v1/withdrawals"].post.responses["202"].headers.Location).toBeDefined();
    expect(openapi["paths"]["/v1/withdrawals"].post.description).toMatch(/trading_unavailable[\s\S]*Retry-After/);
    expect(openapi["paths"]["/v1/withdrawals"].post.description).toMatch(/stays\s+`requested`/);
  });

  it("needs an Idempotency-Key on both POSTs of the money routes", () => {
    for (const path of ["/v1/deposits", "/v1/withdrawals"]) {
      expect(openapi["paths"][path].post.parameters).toEqual([{ $ref: "#/components/parameters/IdempotencyKey" }]);
    }
    const key = openapi["components"].parameters.IdempotencyKey;
    expect(key).toMatchObject({ name: "Idempotency-Key", in: "header", required: true });
    expect(new RegExp(key.schema.pattern).test("a:b.c_d-1")).toBe(true);
    expect(new RegExp(key.schema.pattern).test("with space")).toBe(false);
  });

  it("takes only an amount from the caller: no return URLs, no tenant, no user", () => {
    for (const name of ["CreateDepositRequest", "CreateWithdrawalRequest"]) {
      const schema = openapi["components"].schemas[name];
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties)).toEqual(["amount"]);
      expect(schema.required).toEqual(["amount"]);
    }
    expect(JSON.stringify(openapi["components"].schemas)).not.toMatch(/successUrl|cancelUrl/);
  });

  it("has one Amount of credits = EUR cents with the bounds of the domain, used by every amount", () => {
    expect(openapi["components"].schemas.Amount).toMatchObject({ type: "integer", minimum: AMOUNT_MIN, maximum: AMOUNT_MAX });
    for (const name of ["CreateDepositRequest", "CreateWithdrawalRequest", "Deposit", "Withdrawal"]) {
      expect(openapi["components"].schemas[name].properties.amount).toEqual({ $ref: "#/components/schemas/Amount" });
    }
  });

  it("lists the same states and reasons as the domain", () => {
    const { Deposit, Withdrawal } = openapi["components"].schemas;
    expect(Deposit.properties.status.enum).toEqual([...DEPOSIT_STATUSES]);
    expect(Deposit.properties.failureReason.enum).toEqual([...DEPOSIT_FAILURE_REASONS, null]);
    expect(Withdrawal.properties.status.enum).toEqual([...WITHDRAWAL_STATUSES]);
    expect(Withdrawal.properties.reason.enum).toEqual([...WITHDRAWAL_REJECT_REASONS, ...WITHDRAWAL_FAILURE_REASONS, null]);
  });

  it("describes the webhook as the provider's README does: public, signed, thin", () => {
    const webhook = openapi["paths"]["/v1/webhooks/payment-provider"].post;
    expect(webhook.parameters[0]).toMatchObject({ name: "Provider-Signature", in: "header", required: true });
    expect(webhook.description).toMatch(/300 seconds/);
    expect(webhook.description).toMatch(/read[s]? the object back/);
    expect(Object.keys(webhook.responses)).toEqual(expect.arrayContaining(["200", "400", "401", "503"]));
    expect(openapi["components"].schemas.ProviderEvent.properties.type.enum).toEqual([
      "checkout.session.completed",
      "checkout.session.declined",
      "checkout.session.expired",
      "payout.paid",
      "payout.failed",
    ]);
  });

  it("validates sample bodies against the response schemas", () => {
    const deposit = {
      id: "018f3c1e-7a00-7000-8000-0000000000d1",
      userId: "user-1",
      amount: 2500,
      status: "pending",
      checkoutUrl: "https://pay.example/checkout/cs_1",
      failureReason: null,
      expiresAt: "2026-11-01T10:30:00.000Z",
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-01T10:00:00.000Z",
      completedAt: null,
    };
    const withdrawal = {
      id: "018f3c1e-7a00-7000-8000-0000000000e1",
      userId: "user-1",
      amount: 1800,
      status: "debited",
      reason: null,
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-01T10:00:05.000Z",
      completedAt: null,
    };
    expect(responseErrors("/v1/deposits", "post", 201, deposit)).toEqual([]);
    expect(responseErrors("/v1/deposits/{id}", "get", 200, { ...deposit, status: "failed", failureReason: "expired", completedAt: "2026-11-01T10:30:00.000Z" })).toEqual([]);
    expect(responseErrors("/v1/withdrawals", "post", 202, withdrawal)).toEqual([]);
    expect(responseErrors("/v1/withdrawals", "post", 409, { type: "urn:chance:problem:insufficient-credits", title: "Conflict", status: 409, code: "insufficient_credits", withdrawalId: withdrawal.id })).toEqual([]);
    expect(responseErrors("/v1/deposits", "post", 201, { ...deposit, amount: 0 })).not.toEqual([]);
    expect(responseErrors("/v1/deposits", "post", 201, { ...deposit, status: "done" })).not.toEqual([]);
    expect(responseErrors("/v1/withdrawals", "post", 202, { ...withdrawal, reason: "because" })).not.toEqual([]);
  });
});

describe("contracts/trading-debit.openapi.yaml (proposal)", () => {
  const debit = tradingDebit["paths"]["/v1/internal/debits"].post;

  it("is marked as a proposal and describes one idempotent call", () => {
    expect(tradingDebit["openapi"]).toMatch(/^3\.1\./);
    expect(tradingDebit["info"].title).toMatch(/PROPOSAL/);
    expect(tradingDebit["info"].description).toMatch(/\*\*Proposal\.\*\*/);
    expect(tradingDebit["info"].description).toMatch(/idempotent by\s+`withdrawalId`/);
    expect(Object.keys(tradingDebit["paths"])).toEqual(["/v1/internal/debits"]);
    expect(Object.keys(debit.responses)).toEqual(["200", "400", "401", "403", "409", "422", "503"]);
  });

  it("names the optional Idempotency-Key header that carries the withdrawal id", () => {
    expect(debit.parameters).toEqual([expect.objectContaining({ name: "Idempotency-Key", in: "header", required: false })]);
  });

  it("takes withdrawal id, tenant id, user id and an amount with the bounds of the domain", () => {
    const request = tradingDebit["components"].schemas.DebitRequest;
    expect(request.required).toEqual(["withdrawalId", "tenantId", "userId", "amount"]);
    expect(request.additionalProperties).toBe(false);
    expect(request.properties.amount).toMatchObject({ type: "integer", minimum: AMOUNT_MIN, maximum: AMOUNT_MAX });
  });

  it("is called with the client-credentials token of the client payments", () => {
    expect(tradingDebit["components"].securitySchemes.serviceToken.flows.clientCredentials).toBeDefined();
    expect(tradingDebit["info"].description).toMatch(/client `payments`/);
    expect(debit.responses["503"].headers["Retry-After"]).toBeDefined();
  });

  it("is repeated in the contracts README with the event proposal", () => {
    const readme = readFileSync(new URL("../../contracts/README.md", import.meta.url), "utf8");
    expect(readme).toMatch(/### Proposal 1: the debit call/);
    expect(readme).toMatch(/### Proposal 2: the event WithdrawalRefunded/);
    expect(readme).toMatch(/1 credit = 1 EUR cent/);
    expect(readme).toMatch(/chance\.trading\.WithdrawalRefunded\.<tenantId>/);
  });
});

describe("contracts/asyncapi.yaml", () => {
  it("is AsyncAPI 3.0 with one send channel per published event and a receive channel per consumed event", () => {
    expect(asyncapi["asyncapi"]).toMatch(/^3\.0\./);
    const published: EventName[] = ["DepositSucceeded", "DepositFailed", "WithdrawalSucceeded", "WithdrawalFailed"];
    const all = Object.values(asyncapi["operations"] as Record<string, { action: string; channel: { $ref: string } }>);
    const addressOf = (operation: { channel: { $ref: string } }): string => asyncapi["channels"][operation.channel.$ref.split("/").pop() ?? ""].address;
    expect(all.filter((operation) => operation.action === "send").map(addressOf).sort()).toEqual(published.map((name) => natsSubject(name, "{tenantId}")).sort());
    expect(all.filter((operation) => operation.action === "receive").map(addressOf).sort()).toEqual([
      "chance.tenants.TenantCreated.{tenantId}",
      "chance.trading.WithdrawalRefunded.{tenantId}",
    ]);
  });
});
