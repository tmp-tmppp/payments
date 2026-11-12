import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TENANT_A, createHarness } from "../support/harness.js";

type Harness = Awaited<ReturnType<typeof createHarness>>;

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ probes: true });
});
afterAll(async () => {
  await h.app.close();
});

const PROBLEM = "application/problem+json";

async function call(url: string, token?: Parameters<Harness["bearer"]>[0] | null) {
  const headers = token === null || token === undefined ? {} : await h.bearer(token);
  const response = await h.app.inject({ method: "GET", url, headers });
  return { status: response.statusCode, headers: response.headers, body: response.json<Record<string, any>>() };
}

describe("health probes", () => {
  it.each(["/health/startup", "/health/ready", "/health/live"])("%s answers up without a token", async (url) => {
    const response = await call(url);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "up" });
  });

  it("is not ready while draining, and ready again afterwards", async () => {
    h.setDraining(true);
    const draining = await call("/health/ready");
    h.setDraining(false);
    expect(draining.status).toBe(503);
    expect(draining.headers["content-type"]).toContain(PROBLEM);
    expect(draining.body).toMatchObject({ code: "shutting_down", status: 503 });
    expect((await call("/health/ready")).status).toBe(200);
  });

  it("is not ready when the database does not answer, but stays alive", async () => {
    const ping = h.store.ping.bind(h.store);
    h.store.ping = () => Promise.reject(new Error("db down"));
    const ready = await call("/health/ready");
    const live = await call("/health/live");
    h.store.ping = ping;
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ code: "not_ready" });
    expect(live.status).toBe(200);
  });
});

describe("requests", () => {
  it("answers an unknown path with a problem and a correlation id", async () => {
    const response = await call("/v1/nothing");
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toContain(PROBLEM);
    expect(response.body).toMatchObject({ type: "urn:chance:problem:not-found", status: 404, instance: "/v1/nothing" });
    expect(response.headers["x-correlation-id"]).toBeTruthy();
  });

  it("returns the correlation id the caller sent, and replaces one with odd characters", async () => {
    const kept = await h.app.inject({ method: "GET", url: "/health/live", headers: { "x-correlation-id": "trace-123" } });
    const replaced = await h.app.inject({ method: "GET", url: "/health/live", headers: { "x-correlation-id": "bad id\u0001" } });
    expect(kept.headers["x-correlation-id"]).toBe("trace-123");
    expect(replaced.headers["x-correlation-id"]).not.toBe("bad id\u0001");
    expect(String(replaced.headers["x-correlation-id"])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers 401 with a Bearer challenge when there is no token", async () => {
    const response = await call("/_probe/whoami", null);
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.body).toMatchObject({ status: 401 });
  });
});

describe("the guard of the money endpoints (tenant and user only from the token)", () => {
  it("lets a trader and a tenant admin through, with the tenant in lower case from the token", async () => {
    const trader = await call("/_probe/me", { sub: "u-1", roles: ["trader"], organization: [TENANT_A.toUpperCase()] });
    const admin = await call("/_probe/me", { sub: "u-2", roles: ["tenant-admin"], organization: { [TENANT_A]: { id: "x" } } });
    expect(trader).toMatchObject({ status: 200, body: { tenantId: TENANT_A, userId: "u-1" } });
    expect(admin).toMatchObject({ status: 200, body: { tenantId: TENANT_A, userId: "u-2" } });
  });

  it("refuses a token without the role of a trader or tenant admin", async () => {
    for (const roles of [[], ["platform-admin"], ["something-else"]]) {
      const response = await call("/_probe/me", { roles, organization: [TENANT_A] });
      expect(response.status, roles.join()).toBe(403);
      expect(response.body).toMatchObject({ code: "forbidden" });
    }
  });

  it("refuses a token that belongs to no tenant, or to a tenant that is no UUID", async () => {
    // The role comes from the group of the token's organization (token contract v2): without an organization there is no
    // role, so the answer is "forbidden"; with an organization that is no UUID the role is there and the tenant is refused.
    const organizations: Array<string[] | null | undefined> = [undefined, null, []];
    for (const organization of organizations) {
      const response = await call("/_probe/me", { roles: ["trader"], ...(organization === undefined ? {} : { organization }) });
      expect(response.status, JSON.stringify(organization)).toBe(403);
      expect(response.body).toMatchObject({ code: "forbidden" });
    }
    const notUuid = await call("/_probe/me", { roles: ["trader"], organization: ["acme"] });
    expect(notUuid.status).toBe(403);
    expect(notUuid.body).toMatchObject({ code: "no_tenant" });
  });

  it("takes the role from the group of the organization only, never from the realm roles", async () => {
    const realmOnly = await call("/_probe/me", { realmAccessRoles: ["trader", "tenant-admin"], organization: [TENANT_A] });
    expect(realmOnly.status).toBe(403);
    expect(realmOnly.body).toMatchObject({ code: "forbidden" });
    const viaGroup = await call("/_probe/me", { groups: ["/trader"], organization: [TENANT_A] });
    expect(viaGroup).toMatchObject({ status: 200, body: { tenantId: TENANT_A } });
  });

  it("refuses a token that belongs to more than one organization with a 401", async () => {
    const response = await call("/_probe/me", { roles: ["trader"], organization: [TENANT_A, "other"] });
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("invalid_token");
  });
});

describe("mapping of use-case errors to problems", () => {
  const token = { roles: ["trader"], organization: [TENANT_A] };

  it("maps Unavailable to 503 with Retry-After", async () => {
    const response = await call("/_probe/unavailable", token);
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("7");
    expect(response.headers["content-type"]).toContain(PROBLEM);
    expect(response.body).toMatchObject({ type: "urn:chance:problem:provider-unavailable", code: "provider_unavailable", status: 503 });
  });

  it("maps Conflict to 409, NotFound to 404 and ValidationFailed to 400 with its fields", async () => {
    expect((await call("/_probe/conflict", token)).body).toMatchObject({ status: 409, code: "idempotency_key_reused" });
    expect((await call("/_probe/not-found", token)).body).toMatchObject({ status: 404, code: "deposit_not_found" });
    const invalid = await call("/_probe/invalid", token);
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: "validation_failed", errors: [{ field: "amount", message: "is required" }] });
  });

  it("maps a rule violation of the domain to the use-case error a caller can act on", async () => {
    const response = await call("/_probe/amount?amount=0", token);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "validation_failed", errors: [{ field: "amount" }] });
    expect((await call("/_probe/amount?amount=500", token)).status).toBe(200);
  });

  it("answers an unexpected error with a 500 that does not say what failed", async () => {
    const response = await call("/_probe/boom", token);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: "internal_error", detail: "The service failed to handle the request" });
    expect(JSON.stringify(response.body)).not.toContain("something unexpected");
  });
});
