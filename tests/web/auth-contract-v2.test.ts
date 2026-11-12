import type { FastifyReply, FastifyRequest } from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { authenticate } from "../../src/web/auth.js";
import type { AuthContext } from "../../src/web/auth.js";
import { HttpError } from "../../src/web/problems.js";
import { AUDIENCE, ISSUER, createTestKeys } from "../support/tokens.js";
import type { TokenOptions } from "../support/tokens.js";

// Token contract v2: the token holds exactly one organization; the tenant role is that organization's group
// ("/trader" or "/tenant-admin" in organization.<alias>.groups); platform-admin is a realm role; a tenant role in
// realm_access is ignored. The hook is called directly with a fake request, so no server is needed.

let keys: Awaited<ReturnType<typeof createTestKeys>>;
beforeAll(async () => {
  keys = await createTestKeys();
});

const ALIAS = "acme";

function fakeLog(): Record<string, unknown> {
  const log: Record<string, unknown> = { warn: () => undefined, info: () => undefined };
  log["child"] = () => log;
  return log;
}

/** Runs the authentication hook on a token and returns the caller, or the error it threw. */
async function authenticateToken(options: TokenOptions): Promise<AuthContext | HttpError> {
  const hook = authenticate({ issuer: ISSUER, audience: AUDIENCE, getKey: keys.getKey, rolesClaim: "realm_access.roles", tenantClaim: "organization" });
  const log = fakeLog();
  const request = { headers: { authorization: `Bearer ${await keys.sign(options)}` }, log, auth: null } as unknown as FastifyRequest;
  const reply = { log } as unknown as FastifyReply;
  try {
    await hook(request, reply);
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  if (request.auth === null) throw new Error("the hook left no caller on the request");
  return request.auth;
}

async function callerOf(options: TokenOptions): Promise<AuthContext> {
  const result = await authenticateToken(options);
  if (result instanceof HttpError) throw result;
  return result;
}

describe("the tenant role comes from the group of the one organization", () => {
  it("gives the trader role for the group /trader", async () => {
    expect(await callerOf({ sub: "u-1", organization: { [ALIAS]: { id: "1", groups: ["/trader"] } } })).toEqual({
      userId: "u-1",
      roles: ["trader"],
      tenantId: ALIAS,
    });
  });

  it("gives the tenant-admin role for the group /tenant-admin", async () => {
    const caller = await callerOf({ organization: { [ALIAS]: { groups: ["/tenant-admin"] } } });
    expect(caller.roles).toEqual(["tenant-admin"]);
    expect(caller.tenantId).toBe(ALIAS);
  });

  it("gives no tenant role when the organization has both groups", async () => {
    expect((await callerOf({ organization: { [ALIAS]: { groups: ["/trader", "/tenant-admin"] } } })).roles).toEqual([]);
  });

  it("counts the same group twice as one group", async () => {
    expect((await callerOf({ organization: { [ALIAS]: { groups: ["/trader", "/trader"] } } })).roles).toEqual(["trader"]);
  });

  it("ignores groups that are no tenant role, and keeps the one that is", async () => {
    expect((await callerOf({ organization: { [ALIAS]: { groups: ["/staff", "/trader", "/other/tenant-admin", "trader"] } } })).roles).toEqual(["trader"]);
  });

  it.each([
    ["no groups key", { [ALIAS]: { id: "1" } }],
    ["an empty list", { [ALIAS]: { groups: [] } }],
    ["groups that are no list", { [ALIAS]: { groups: "/trader" } }],
    ["an entry that is no object", { [ALIAS]: "/trader" }],
    ["groups of other kinds", { [ALIAS]: { groups: [1, null, { path: "/trader" }] } }],
    ["groups without the slash", { [ALIAS]: { groups: ["trader", "tenant-admin"] } }],
  ])("gives no tenant role for %s", async (_label, organization) => {
    const caller = await callerOf({ organization });
    expect(caller.roles).toEqual([]);
    expect(caller.tenantId).toBe(ALIAS);
  });

  it("reads the groups from the claim path it is configured with", async () => {
    const hook = authenticate({ issuer: ISSUER, audience: AUDIENCE, getKey: keys.getKey, rolesClaim: "roles", tenantClaim: "orgs" });
    const log = fakeLog();
    const token = await keys.sign({ claims: { roles: ["platform-admin", "trader"], orgs: { [ALIAS]: { groups: ["/tenant-admin"] } } } });
    const request = { headers: { authorization: `Bearer ${token}` }, log, auth: null } as unknown as FastifyRequest;
    await hook(request, { log } as unknown as FastifyReply);
    expect(request.auth).toMatchObject({ roles: ["platform-admin", "tenant-admin"], tenantId: ALIAS });
  });
});

describe("a tenant role in the realm roles is ignored", () => {
  it.each(["trader", "tenant-admin"])("ignores %s in realm_access when the organization has no group", async (role) => {
    const caller = await callerOf({ realmAccessRoles: [role], organization: { [ALIAS]: { groups: [] } } });
    expect(caller.roles).toEqual([]);
  });

  it("does not let a realm role stand in for the group of the organization", async () => {
    const caller = await callerOf({ realmAccessRoles: ["tenant-admin"], organization: { [ALIAS]: { groups: ["/trader"] } } });
    expect(caller.roles).toEqual(["trader"]);
  });

  it("ignores a tenant role in the realm roles of a token without an organization", async () => {
    const caller = await callerOf({ realmAccessRoles: ["trader", "tenant-admin"] });
    expect(caller).toMatchObject({ roles: [], tenantId: null });
  });

  it("keeps platform-admin from the realm roles next to the group's role", async () => {
    const caller = await callerOf({ realmAccessRoles: ["platform-admin", "trader"], organization: { [ALIAS]: { groups: ["/tenant-admin"] } } });
    expect(caller.roles).toEqual(["platform-admin", "tenant-admin"]);
  });
});

describe("platform-admin", () => {
  it("comes from the realm roles, with or without an organization", async () => {
    expect(await callerOf({ realmAccessRoles: ["platform-admin"] })).toMatchObject({ roles: ["platform-admin"], tenantId: null });
    expect((await callerOf({ roles: ["platform-admin"], organization: { [ALIAS]: { groups: [] } } })).roles).toEqual(["platform-admin"]);
  });

  it("is not given by a group of an organization", async () => {
    expect((await callerOf({ organization: { [ALIAS]: { groups: ["/platform-admin"] } } })).roles).toEqual([]);
  });
});

describe("the organizations of the token", () => {
  it("rejects a token with two organizations with 401, also when one of them has a group", async () => {
    for (const organization of [
      { a: { groups: ["/trader"] }, b: { groups: [] } },
      { a: { groups: ["/trader"] }, b: { groups: ["/tenant-admin"] } },
    ]) {
      const error = await authenticateToken({ organization });
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 401, code: "unauthorized", message: "The token belongs to more than one organization" });
    }
  });

  it("accepts a token without an organization: no tenant, no tenant role", async () => {
    expect(await callerOf({})).toEqual({ userId: "user-1", roles: [], tenantId: null });
    expect(await callerOf({ organization: {} })).toMatchObject({ roles: [], tenantId: null });
  });

  it("takes an alias given as a list or as text, without groups and so without a tenant role", async () => {
    const asList = await callerOf({ claims: { organization: [ALIAS] } });
    expect(asList).toMatchObject({ roles: [], tenantId: ALIAS });
    const asText = await callerOf({ claims: { organization: ALIAS } });
    expect(asText).toMatchObject({ roles: [], tenantId: ALIAS });
    expect(await authenticateToken({ claims: { organization: ["a", "b"] } })).toMatchObject({ status: 401 });
  });

  it("builds the organization claim from the shorthand roles of the test tokens as contract v2 does", async () => {
    const caller = await callerOf({ roles: ["tenant-admin"], organization: [ALIAS] });
    expect(caller).toMatchObject({ roles: ["tenant-admin"], tenantId: ALIAS });
  });
});
