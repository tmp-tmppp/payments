import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Registry } from "prom-client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NO_TENANT, UNMATCHED_ROUTE, createMetrics, startMetricsServer } from "../../src/adapters/metrics/metrics.js";
import type { Metrics, MetricsServer } from "../../src/adapters/metrics/metrics.js";
import { authenticate, tenantOfRequest } from "../../src/web/auth.js";
import { registerProblemHandlers } from "../../src/web/problems.js";
import { AUDIENCE, ISSUER, createTestKeys } from "../support/tokens.js";

// The metrics convention (header of src/adapters/metrics/metrics.ts) is tested on a small application of its own: the
// real token check (a signed test token, really verified), the real problem handlers, and three routes. The wiring
// into the real application is in tests/web/metrics.test.ts.

let keys: Awaited<ReturnType<typeof createTestKeys>>;
beforeAll(async () => {
  keys = await createTestKeys();
});

interface Sample {
  labels: Record<string, string | number>;
  value: number;
  metricName?: string;
}

async function samples(registry: Registry, name: string): Promise<Sample[]> {
  const metric = registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  return (await metric.get()).values as Sample[];
}

/** The count of the one counter sample with exactly these labels (0 when there is none). */
async function counted(registry: Registry, labels: Record<string, string>): Promise<number> {
  const found = (await samples(registry, "http_requests_total")).filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value));
  return found.reduce((sum, sample) => sum + sample.value, 0);
}

const slept = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function buildTestApp(metrics: Metrics): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  metrics.attach(app);
  registerProblemHandlers(app);
  const authHook = authenticate({ issuer: ISSUER, audience: AUDIENCE, getKey: keys.getKey, rolesClaim: "realm_access.roles", tenantClaim: "organization" });
  app.get("/open", () => ({ ok: true }));
  app.get<{ Params: { id: string } }>("/v1/items/:id", { onRequest: authHook }, (request) => ({ id: request.params.id }));
  app.post("/v1/items", { onRequest: authHook }, (_request, reply) => reply.code(201).send({ created: true }));
  app.get<{ Params: { id: string } }>("/v1/gone/:id", (_request, reply) => reply.code(404).send({ gone: true }));
  app.get("/v1/boom", () => {
    throw new Error("the handler failed");
  });
  app.get("/v1/slow", async () => {
    await slept(40);
    return { slow: true };
  });
  return app;
}

function newApp(tenantOf?: Parameters<typeof createMetrics>[0]["tenantOf"]) {
  const metrics = createMetrics({ tenantOf: tenantOf ?? tenantOfRequest });
  return { metrics, app: buildTestApp(metrics) };
}

const bearer = async (options: Parameters<typeof keys.sign>[0]) => ({ authorization: `Bearer ${await keys.sign(options)}` });

describe("the labels of http_requests_total", () => {
  it("uses the route template, the method, the status code and the tenant of a verified token", async () => {
    const { metrics, app } = newApp();
    const response = await app.inject({ method: "GET", url: "/v1/items/abc-123", headers: await bearer({ organization: ["acme"], roles: ["trader"] }) });
    expect(response.statusCode).toBe(200);
    expect(await samples(metrics.registry, "http_requests_total")).toEqual([
      { value: 1, labels: { method: "GET", route: "/v1/items/:id", status_code: "200", tenant: "acme" } },
    ]);
    await app.close();
  });

  it("never lets a raw URL or an id become a label value", async () => {
    const { metrics, app } = newApp();
    await app.inject({ method: "GET", url: "/v1/items/secret-id-1", headers: await bearer({ organization: ["acme"] }) });
    await app.inject({ method: "GET", url: "/v1/items/secret-id-2", headers: await bearer({ organization: ["acme"] }) });
    await app.inject({ method: "GET", url: "/no/such/path/secret-id-3?query=secret-id-4" });
    const text = await metrics.registry.metrics();
    expect(text).not.toMatch(/secret-id/);
    expect(await counted(metrics.registry, { route: "/v1/items/:id" })).toBe(2);
    await app.close();
  });

  it('labels a request that matched no route "unmatched" with status 404', async () => {
    const { metrics, app } = newApp();
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
    expect(await samples(metrics.registry, "http_requests_total")).toEqual([
      { value: 1, labels: { method: "GET", route: UNMATCHED_ROUTE, status_code: "404", tenant: NO_TENANT } },
    ]);
    await app.close();
  });

  it("keeps the route template when a matched route itself answers 404", async () => {
    const { metrics, app } = newApp();
    await app.inject({ method: "GET", url: "/v1/gone/42" });
    expect(await counted(metrics.registry, { route: "/v1/gone/:id", status_code: "404" })).toBe(1);
    expect(await counted(metrics.registry, { route: UNMATCHED_ROUTE })).toBe(0);
    await app.close();
  });

  it("records the status code of each answer: 201, 401, 404 and 500", async () => {
    const { metrics, app } = newApp();
    await app.inject({ method: "POST", url: "/v1/items", headers: await bearer({ organization: ["acme"] }), payload: {} });
    await app.inject({ method: "GET", url: "/v1/items/1" });
    await app.inject({ method: "GET", url: "/v1/gone/1" });
    await app.inject({ method: "GET", url: "/v1/boom" });
    expect(await counted(metrics.registry, { method: "POST", route: "/v1/items", status_code: "201", tenant: "acme" })).toBe(1);
    expect(await counted(metrics.registry, { route: "/v1/items/:id", status_code: "401", tenant: NO_TENANT })).toBe(1);
    expect(await counted(metrics.registry, { route: "/v1/gone/:id", status_code: "404" })).toBe(1);
    expect(await counted(metrics.registry, { route: "/v1/boom", status_code: "500", tenant: NO_TENANT })).toBe(1);
    await app.close();
  });

  it("counts every request of the same labels in one sample", async () => {
    const { metrics, app } = newApp();
    for (let i = 0; i < 3; i += 1) await app.inject({ method: "GET", url: "/open" });
    expect(await samples(metrics.registry, "http_requests_total")).toEqual([
      { value: 3, labels: { method: "GET", route: "/open", status_code: "200", tenant: NO_TENANT } },
    ]);
    await app.close();
  });
});

describe("the tenant label", () => {
  it("is the organization of a signed token that the service verified, one value per tenant", async () => {
    const { metrics, app } = newApp();
    await app.inject({ method: "GET", url: "/v1/items/1", headers: await bearer({ organization: ["acme"], roles: ["tenant-admin"] }) });
    await app.inject({ method: "GET", url: "/v1/items/1", headers: await bearer({ organization: ["globex"] }) });
    await app.inject({ method: "GET", url: "/v1/items/1", headers: await bearer({ organization: ["globex"] }) });
    expect(await counted(metrics.registry, { tenant: "acme" })).toBe(1);
    expect(await counted(metrics.registry, { tenant: "globex" })).toBe(2);
    await app.close();
  });

  it('is "none" for a verified token that names no organization', async () => {
    const { metrics, app } = newApp();
    const response = await app.inject({ method: "GET", url: "/v1/items/1", headers: await bearer({ roles: ["platform-admin"] }) });
    expect(response.statusCode).toBe(200);
    expect(await counted(metrics.registry, { route: "/v1/items/:id", status_code: "200", tenant: NO_TENANT })).toBe(1);
    await app.close();
  });

  it('is "none" for a token the service rejected: wrong key, expired, wrong audience', async () => {
    const { metrics, app } = newApp();
    const rejected = [
      { authorization: `Bearer ${await keys.signWithOtherKey({ organization: ["acme"] })}` },
      await bearer({ organization: ["acme"], expiresIn: -60 }),
      await bearer({ organization: ["acme"], audience: "another-audience" }),
    ];
    for (const headers of rejected) expect((await app.inject({ method: "GET", url: "/v1/items/1", headers })).statusCode).toBe(401);
    expect(await counted(metrics.registry, { status_code: "401", tenant: NO_TENANT })).toBe(3);
    expect(await counted(metrics.registry, { tenant: "acme" })).toBe(0);
    await app.close();
  });

  it('is "none" on a route that never verifies the token, even when the request carries a valid one', async () => {
    const { metrics, app } = newApp();
    await app.inject({ method: "GET", url: "/open", headers: await bearer({ organization: ["acme"] }) });
    expect(await counted(metrics.registry, { route: "/open", tenant: NO_TENANT })).toBe(1);
    await app.close();
  });

  it("is never taken from a header or the body of the request", async () => {
    const { metrics, app } = newApp();
    await app.inject({ method: "GET", url: "/open", headers: { "x-tenant-id": "acme", "x-tenant": "acme", tenant: "acme" } });
    await app.inject({ method: "POST", url: "/v1/items", headers: { "x-tenant-id": "acme" }, payload: { tenant: "acme", tenantId: "acme" } });
    expect(await counted(metrics.registry, { tenant: "acme" })).toBe(0);
    expect(await counted(metrics.registry, { tenant: NO_TENANT })).toBe(2);
    await app.close();
  });

  it.each([
    ["null", () => null],
    ["undefined", () => undefined],
    ["an empty string", () => ""],
    ["a function that throws", () => { throw new Error("no auth here"); }],
  ])('is "none" when the service gives %s', async (_label, tenantOf) => {
    const { metrics, app } = newApp(tenantOf);
    expect((await app.inject({ method: "GET", url: "/open" })).statusCode).toBe(200);
    expect(await counted(metrics.registry, { route: "/open", tenant: NO_TENANT })).toBe(1);
    await app.close();
  });
});

describe("http_request_duration_seconds", () => {
  it("observes every request: the count, the sum and the cumulative buckets of the default buckets", async () => {
    const { metrics, app } = newApp();
    await app.inject({ method: "GET", url: "/v1/slow" });
    await app.inject({ method: "GET", url: "/open" });
    const values = await samples(metrics.registry, "http_request_duration_seconds");
    const of = (name: string, route: string, le?: string) =>
      values.find((sample) => sample.metricName === name && sample.labels["route"] === route && (le === undefined || String(sample.labels["le"]) === le));

    expect(of("http_request_duration_seconds_count", "/v1/slow")?.value).toBe(1);
    expect(of("http_request_duration_seconds_count", "/open")?.value).toBe(1);
    // The slow route sleeps 40 ms: its sum is at least that (a timer may fire a millisecond early), it is in no bucket
    // up to 25 ms, and every request is in the +Inf bucket.
    expect(of("http_request_duration_seconds_sum", "/v1/slow")?.value).toBeGreaterThanOrEqual(0.035);
    expect(of("http_request_duration_seconds_bucket", "/v1/slow", "0.025")?.value).toBe(0);
    expect(of("http_request_duration_seconds_bucket", "/v1/slow", "+Inf")?.value).toBe(1);
    expect(of("http_request_duration_seconds_sum", "/open")?.value).toBeGreaterThanOrEqual(0);
    // The default buckets of prom-client, and the labels of the counter on every sample.
    const bounds = values.filter((sample) => sample.metricName === "http_request_duration_seconds_bucket" && sample.labels["route"] === "/open").map((sample) => String(sample.labels["le"]));
    expect(bounds).toEqual(["0.005", "0.01", "0.025", "0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "10", "+Inf"]);
    expect(of("http_request_duration_seconds_count", "/open")?.labels).toEqual({ method: "GET", route: "/open", status_code: "200", tenant: NO_TENANT });
    await app.close();
  });

  it("measures from the start of the request: the time of the token check is inside it", async () => {
    const slowKey = async (...args: Parameters<typeof keys.getKey>) => {
      await slept(40);
      return keys.getKey(...args);
    };
    const metrics = createMetrics({ tenantOf: tenantOfRequest });
    const app = Fastify({ logger: false });
    app.decorateRequest("auth", null);
    metrics.attach(app);
    registerProblemHandlers(app);
    const authHook = authenticate({ issuer: ISSUER, audience: AUDIENCE, getKey: slowKey, rolesClaim: "realm_access.roles", tenantClaim: "organization" });
    app.get("/v1/checked", { onRequest: authHook }, () => ({ ok: true }));
    expect((await app.inject({ method: "GET", url: "/v1/checked", headers: await bearer({ organization: ["acme"] }) })).statusCode).toBe(200);
    const sum = (await samples(metrics.registry, "http_request_duration_seconds")).find((sample) => sample.metricName === "http_request_duration_seconds_sum");
    expect(sum?.value).toBeGreaterThanOrEqual(0.035);
    await app.close();
  });
});

describe("the registry", () => {
  it("holds the default process metrics next to the two HTTP metrics", async () => {
    const { metrics } = newApp();
    const text = await metrics.registry.metrics();
    expect(text).toContain("# TYPE http_requests_total counter");
    expect(text).toContain("# TYPE http_request_duration_seconds histogram");
    expect(text).toContain("process_cpu_user_seconds_total");
    expect(text).toContain("nodejs_eventloop_lag_seconds");
  });

  it("is the service's own: two services in one process do not share counts", async () => {
    const first = newApp();
    const second = newApp();
    await first.app.inject({ method: "GET", url: "/open" });
    expect(await counted(first.metrics.registry, { route: "/open" })).toBe(1);
    expect(await counted(second.metrics.registry, { route: "/open" })).toBe(0);
    await first.app.close();
    await second.app.close();
  });
});

describe("the metrics listener", () => {
  const started: MetricsServer[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(started.splice(0).map((server) => server.close().catch(() => undefined)));
  });

  async function listener(registry: Registry): Promise<{ server: MetricsServer; url: (path: string) => string }> {
    const server = await startMetricsServer(registry, { port: 0, host: "127.0.0.1" });
    started.push(server);
    return { server, url: (path) => `http://127.0.0.1:${server.port}${path}` };
  }

  it("serves GET /metrics in the Prometheus text format, with what the application recorded", async () => {
    const { metrics, app } = newApp();
    await app.inject({ method: "GET", url: "/v1/items/9", headers: await bearer({ organization: ["acme"] }) });
    const { url } = await listener(metrics.registry);
    const response = await fetch(url("/metrics"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);
    const body = await response.text();
    expect(body).toContain("# HELP http_requests_total ");
    expect(body).toContain('http_requests_total{method="GET",route="/v1/items/:id",status_code="200",tenant="acme"} 1');
    expect(body).toContain('http_request_duration_seconds_count{method="GET",route="/v1/items/:id",status_code="200",tenant="acme"} 1');
    expect(body).toContain("process_cpu_user_seconds_total");
    await app.close();
  });

  it("ignores a query string", async () => {
    const { metrics } = newApp();
    const { url } = await listener(metrics.registry);
    expect((await fetch(url("/metrics?name[]=http_requests_total"))).status).toBe(200);
  });

  it("answers 404 on every other path", async () => {
    const { metrics } = newApp();
    const { url } = await listener(metrics.registry);
    for (const path of ["/", "/metrics/", "/Metrics", "/health/live", "/v1/me", "/metrics/extra", "//"]) {
      const response = await fetch(url(path));
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain("# TYPE");
    }
  });

  it("answers 405 with Allow: GET to another method on /metrics", async () => {
    const { metrics } = newApp();
    const { url } = await listener(metrics.registry);
    const response = await fetch(url("/metrics"), { method: "POST", body: "x" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("answers 500 without details when the registry cannot be read", async () => {
    const { metrics } = newApp();
    vi.spyOn(metrics.registry, "metrics").mockRejectedValue(new Error("internal detail"));
    const { url } = await listener(metrics.registry);
    const response = await fetch(url("/metrics"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("internal detail");
  });

  it("binds the port it is given and refuses to start on a port that is taken", async () => {
    const { metrics } = newApp();
    const { server } = await listener(metrics.registry);
    expect(server.port).toBeGreaterThan(0);
    await expect(startMetricsServer(metrics.registry, { port: server.port, host: "127.0.0.1" })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("closes with the service: it stops answering, also with an idle keep-alive connection of a scraper open", async () => {
    const { metrics } = newApp();
    const { server, url } = await listener(metrics.registry);
    expect((await fetch(url("/metrics"), { headers: { connection: "keep-alive" } })).status).toBe(200);
    await server.close();
    await expect(fetch(url("/metrics"))).rejects.toThrow();
  });
});
