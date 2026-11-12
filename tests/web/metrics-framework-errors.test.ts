import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetrics } from "../../src/adapters/metrics/metrics.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { tenantOfRequest } from "../../src/web/auth.js";
import { TENANT_A, createHarness } from "../support/harness.js";

// Fastify answers a URL it cannot route (a malformed percent-encoding) through its frameworkErrors handler, on a
// request that carries none of the application's hooks. Those answers are still counted: a burst of them must show on
// the request-rate and status panels, as route "unmatched" and tenant "none".

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

async function sampleSum(name: string, labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric(name.replace(/_count$/, ""));
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => ((sample as { metricName?: string }).metricName ?? name) === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}

const trader = { roles: ["trader"], organization: [TENANT_A], sub: "user-1" };

describe("the metrics of the answers Fastify gives before a route matches", () => {
  it("counts a malformed URL as a 400 on the route unmatched, for the tenant none, and observes its duration", async () => {
    const answer = await h.app.inject({ method: "GET", url: "/v1/deposits/%E0%A4%A", headers: await h.bearer(trader) });
    expect(answer.statusCode).toBe(400);
    const labels = { method: "GET", route: "unmatched", status_code: "400", tenant: "none" };
    expect(await sampleSum("http_requests_total", labels)).toBe(1);
    expect(await sampleSum("http_request_duration_seconds_count", labels)).toBe(1);
  });

  it("does not count a framework error twice, and leaves the counting of routed requests alone", async () => {
    const routed = async (status: number) => sampleSum("http_requests_total", { method: "GET", route: "/v1/deposits/:id", status_code: String(status), tenant: TENANT_A });
    const unmatchedBefore = await sampleSum("http_requests_total", { method: "GET", route: "unmatched", status_code: "400", tenant: "none" });
    const response = await h.app.inject({ method: "GET", url: "/v1/deposits/deposit-id-from-the-url", headers: await h.bearer(trader) });
    const routedBefore = (await routed(response.statusCode)) - 1;
    expect((await h.app.inject({ method: "GET", url: "/v1/deposits/%E0%A4%A", headers: await h.bearer(trader) })).statusCode).toBe(400);
    expect(await routed(response.statusCode)).toBe(routedBefore + 1);
    expect(await sampleSum("http_requests_total", { method: "GET", route: "unmatched", status_code: "400", tenant: "none" })).toBe(unmatchedBefore + 1);
  });
});
