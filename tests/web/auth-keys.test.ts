import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { createRemoteJWKSet, errors } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import { createUseCases } from "../../src/usecases/application.js";
import { buildApp } from "../../src/web/app.js";
import { addProbeRoutes, createCore, createHarness } from "../support/harness.js";
import { AUDIENCE, ISSUER, createTestKeys } from "../support/tokens.js";

// A failure to get the signing keys is the identity provider's outage, not a wrong token: 503 with Retry-After,
// never 401 (a client would give up on a token that is fine). A token that is wrong stays 401.

type Harness = Awaited<ReturnType<typeof createHarness>>;

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ probes: true });
});
afterAll(async () => {
  await h.app.close();
});

const PROBLEM = "application/problem+json";

async function get(url: string, token: string | null) {
  const response = await h.app.inject({ method: "GET", url, headers: token === null ? {} : { authorization: `Bearer ${token}` } });
  return { status: response.statusCode, headers: response.headers, body: response.json<Record<string, unknown>>() };
}

describe("a key resolver that fails (injected into the application)", () => {
  const unavailable: Array<[string, () => unknown]> = [
    ["a timeout", () => new errors.JWKSTimeout()],
    ["a key set that cannot be read", () => new errors.JWKSInvalid("JSON Web Key Set malformed")],
    ["a bad HTTP status", () => new errors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response")],
    ["a body that is no JSON", () => new errors.JOSEError("Failed to parse the JSON Web Key Set HTTP response as JSON")],
    ["a network error", () => new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8081") })],
    ["a DNS error", () => Object.assign(new Error("getaddrinfo ENOTFOUND identity"), { code: "ENOTFOUND" })],
    ["a rejection with something that is no error", () => "boom"],
  ];

  it.each(unavailable)("answers 503 problem+json with Retry-After for %s", async (_label, makeError) => {
    const token = await h.keys.sign({ sub: "user-1" });
    h.failKeys(makeError());
    try {
      for (const url of ["/_probe/whoami", "/_probe/me"]) {
        const response = await get(url, token);
        expect(response.status, url).toBe(503);
        expect(response.headers["content-type"]).toContain(PROBLEM);
        expect(response.headers["retry-after"]).toBe("5");
        expect(response.headers["www-authenticate"]).toBeUndefined();
        expect(response.body).toMatchObject({
          type: "urn:chance:problem:identity-provider-unavailable",
          title: "Service Unavailable",
          status: 503,
          code: "identity_provider_unavailable",
          instance: url,
        });
      }
    } finally {
      h.failKeys(null);
    }
    expect((await get("/_probe/whoami", token)).status).toBe(200);
  });

  it("logs the failure as a warning and neither the token nor the cause in the answer", async () => {
    const token = await h.keys.sign({ sub: "log-503" });
    h.failKeys(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 10.1.2.3:8081") }));
    const before = h.logLines.length;
    const response = await get("/_probe/whoami", token);
    h.failKeys(null);

    expect(JSON.stringify(response.body)).not.toContain("ECONNREFUSED");
    const logged = h.logLines.slice(before).join("");
    expect(logged).toContain("The signing keys of the identity provider cannot be fetched");
    expect(logged).not.toContain(token);
  });

  it("answers 401, not 503, when the problem is the token: unknown or ambiguous key id", async () => {
    const token = await h.keys.sign({});
    for (const error of [new errors.JWKSNoMatchingKey(), new errors.JWKSMultipleMatchingKeys()]) {
      h.failKeys(error);
      const response = await get("/_probe/whoami", token);
      expect(response.status, error.code).toBe(401);
      expect(response.headers["www-authenticate"]).toContain("invalid_token");
      expect(response.headers["retry-after"]).toBeUndefined();
    }
    h.failKeys(null);
  });

  it("does not ask for keys when there is no token, and answers 401 as before", async () => {
    h.failKeys(new TypeError("fetch failed"));
    try {
      expect((await get("/_probe/whoami", null)).status).toBe(401);
    } finally {
      h.failKeys(null);
    }
  });
});

describe("a real remote key set (jose createRemoteJWKSet against a local server)", () => {
  type Handler = (request: IncomingMessage, response: ServerResponse) => void;
  let server: Server;
  let handler: Handler = (_request, response) => response.writeHead(404).end();
  let url = "";
  const keysPromise = createTestKeys();

  beforeAll(async () => {
    server = createServer((request, response) => handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/certs`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /** A new application over a new remote key set: jose caches a key set it has fetched. */
  async function appOver(getKey: JWTVerifyGetKey) {
    const sink = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const auth = { issuer: ISSUER, audience: AUDIENCE, getKey, rolesClaim: "realm_access.roles", tenantClaim: "organization" };
    const app = buildApp({
      logger: createLogger("silent", sink),
      auth,
      health: { ping: () => Promise.resolve(), isDraining: () => false },
      useCases: createUseCases(createCore().deps),
      webhook: { secret: null, nowSeconds: () => 0 },
    });
    addProbeRoutes(app, auth);
    await app.ready();
    return app;
  }

  async function call(options: { handler: Handler; token?: (keys: Awaited<typeof keysPromise>) => Promise<string>; jwksUrl?: string; timeoutDuration?: number }) {
    const keys = await keysPromise;
    handler = options.handler;
    const app = await appOver(createRemoteJWKSet(new URL(options.jwksUrl ?? url), { timeoutDuration: options.timeoutDuration ?? 1000 }));
    try {
      const token = await (options.token ?? ((k) => k.sign({ sub: "remote-user" })))(keys);
      const response = await app.inject({ method: "GET", url: "/_probe/whoami", headers: { authorization: `Bearer ${token}` } });
      return { status: response.statusCode, headers: response.headers, body: response.json<Record<string, unknown>>() };
    } finally {
      await app.close();
    }
  }

  /** The key server of a working identity provider: publishes the public key the test tokens are signed with. */
  const publishing: Handler = (_request, response) => {
    void keysPromise
      .then((keys) => keys.jwks())
      .then((jwks) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(jwks)));
  };

  it("accepts a token signed with a published key", async () => {
    const response = await call({ handler: publishing });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ userId: "remote-user" });
  });

  it("answers 503 when the key server answers with an error status", async () => {
    for (const status of [500, 502, 503, 404, 302]) {
      const response = await call({ handler: (_request, res) => res.writeHead(status, status === 302 ? { location: "/elsewhere" } : {}).end("nope") });
      expect(response.status, String(status)).toBe(503);
      expect(response.headers["retry-after"]).toBe("5");
      expect(response.body).toMatchObject({ code: "identity_provider_unavailable" });
    }
  });

  it("answers 503 when the key server sends something that is no key set", async () => {
    const notJson = await call({ handler: (_request, res) => res.writeHead(200).end("<html>maintenance</html>") });
    expect(notJson.status).toBe(503);
    for (const body of ['{"keys":"nope"}', '{"keys":[1]}', "[]", "null"]) {
      const response = await call({ handler: (_request, res) => res.writeHead(200, { "content-type": "application/json" }).end(body) });
      expect(response.status, body).toBe(503);
    }
  });

  it("answers 503 when the key server does not answer in time", async () => {
    const response = await call({ handler: () => undefined, timeoutDuration: 100 });
    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
  });

  it("answers 503 when nothing listens at the address of the key server", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));

    const response = await call({ handler: publishing, jwksUrl: `http://127.0.0.1:${port}/certs` });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 503, code: "identity_provider_unavailable" });
  });

  it("keeps answering 401 for tokens that are wrong, while the key server works", async () => {
    const bad: Array<[string, (keys: Awaited<typeof keysPromise>) => Promise<string>]> = [
      ["an expired token", (keys) => keys.sign({ expiresIn: -60 })],
      ["a bad signature", (keys) => keys.signWithOtherKey({})],
      ["a wrong issuer", (keys) => keys.sign({ issuer: "http://localhost:8081/realms/other" })],
      ["a wrong audience", (keys) => keys.sign({ audience: "someone-else" })],
      ["an unknown key id", (keys) => keys.sign({ kid: "not-published" })],
      ["a malformed token", () => Promise.resolve("not.a.jwt")],
    ];
    for (const [label, token] of bad) {
      const response = await call({ handler: publishing, token });
      expect(response.status, label).toBe(401);
      expect(response.headers["www-authenticate"], label).toContain("invalid_token");
      expect(response.headers["retry-after"], label).toBeUndefined();
    }
  });
});
