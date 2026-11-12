import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetrics } from "../../src/adapters/metrics/metrics.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { tenantOfRequest } from "../../src/web/auth.js";
import { TENANT_A, createHarness } from "../support/harness.js";

// The metrics wired into the real application the way src/main.ts wires them: the tenant label is the tenant of the
// token that the service verified. The convention itself is tested in tests/adapters/metrics.test.ts.

type Harness = Awaited<ReturnType<typeof createHarness>>;

let metrics: Metrics;
let h: Harness;
beforeAll(async () => {
  metrics = createMetrics({ tenantOf: tenantOfRequest });
  h = await createHarness({ metrics });
});
afterAll(async () => {
  await h.app.close();
});

async function counter(labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric("http_requests_total");
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}

const trader = { roles: ["trader"], organization: [TENANT_A], sub: "user-1" };

describe("the metrics of the real application", () => {
  it("counts a deposit under the template of its route and the tenant of its token", async () => {
    const headers = { ...(await h.bearer(trader)), "idempotency-key": "metrics-1", "content-type": "application/json" };
    const response = await h.app.inject({ method: "POST", url: "/v1/deposits", headers, payload: JSON.stringify({ amount: 2500 }) });
    expect(response.statusCode).toBe(201);
    expect(await counter({ method: "POST", route: "/v1/deposits", status_code: "201", tenant: TENANT_A })).toBe(1);
  });

  it("uses the template for a route with a path parameter, never the id from the URL", async () => {
    const response = await h.app.inject({ method: "GET", url: "/v1/deposits/deposit-id-from-the-url", headers: await h.bearer(trader) });
    expect(await counter({ method: "GET", route: "/v1/deposits/:id", status_code: String(response.statusCode), tenant: TENANT_A })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain("deposit-id-from-the-url");
  });

  it('counts a request without a token as 401 for the tenant "none"', async () => {
    const response = await h.app.inject({ method: "GET", url: "/v1/withdrawals/some-id" });
    expect(response.statusCode).toBe(401);
    expect(await counter({ method: "GET", route: "/v1/withdrawals/:id", status_code: "401", tenant: "none" })).toBe(1);
  });

  it("counts a refused request under the tenant of the token that was verified", async () => {
    const response = await h.app.inject({ method: "GET", url: "/v1/deposits/some-id", headers: await h.bearer({ ...trader, roles: [] }) });
    expect(response.statusCode).toBe(403);
    expect(await counter({ method: "GET", route: "/v1/deposits/:id", status_code: "403", tenant: TENANT_A })).toBe(1);
  });

  it('counts the public webhook, which carries no user token, under the tenant "none"', async () => {
    const response = await h.webhook({ id: "evt-1", type: "unknown" }, { secret: "not-the-shared-secret" });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await counter({ method: "POST", route: "/v1/webhooks/payment-provider", status_code: String(response.statusCode), tenant: "none" })).toBe(1);
  });

  it("counts the probes under their own routes", async () => {
    expect((await h.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect(await counter({ method: "GET", route: "/health/live", status_code: "200", tenant: "none" })).toBe(1);
  });

  it('does not serve /metrics on the API port: the answer is a 404 counted as "unmatched"', async () => {
    const response = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("http_requests_total");
    expect(await counter({ method: "GET", route: "unmatched", status_code: "404", tenant: "none" })).toBe(1);
  });

  it("answers the same without the metrics: the hook is optional", async () => {
    const plain = await createHarness();
    expect((await plain.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    await plain.app.close();
  });
});
