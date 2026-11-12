import { describe, expect, it } from "vitest";
import { ConfigError, MAX_SHUTDOWN_DELAY_MS, loadConfig } from "../src/config.js";

const production = {
  DATABASE_URL: "postgres://app:pw@db:5432/payments",
  NATS_URL: "nats://nats:4222",
  PROVIDER_BASE_URL: "http://payment-provider:8080",
  PROVIDER_API_KEY: "provider-api-key-value",
  WEBHOOK_SECRET: "provider-webhook-secret-value",
  TRADING_BASE_URL: "http://trading:8080",
  TRADING_GRPC_URL: "trading:8082",
  KEYCLOAK_TOKEN_URL: "http://keycloak:8080/realms/chance/protocol/openid-connect/token",
  KEYCLOAK_CLIENT_SECRET: "client-pw",
  DEPOSIT_SUCCESS_URL: "https://chance.example/deposits/success",
  DEPOSIT_CANCEL_URL: "https://chance.example/deposits/cancelled",
  AUTH_JWKS_URL: "http://keycloak:8080/realms/chance/protocol/openid-connect/certs",
  AUTH_ISSUER: "http://keycloak:8080/realms/chance",
  AUTH_AUDIENCE: "chance",
};

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
};

describe("loadConfig", () => {
  it("reads a complete production configuration and applies the defaults", () => {
    expect(loadConfig(production)).toMatchObject({
      appEnv: "production",
      isLocal: false,
      port: 8080,
      metricsPort: 9464,
      logLevel: "info",
      forcePayoutFailure: false,
      runtimeKeysFromEnv: [],
      runtimeConfigDir: null,
      localTenantIds: [],
      runtimeConfigPollMs: 10_000,
      databaseUrl: production.DATABASE_URL,
      databasePoolMax: 5,
      natsUrl: production.NATS_URL,
      provider: { baseUrl: production.PROVIDER_BASE_URL, apiKey: production.PROVIDER_API_KEY },
      webhookSecret: production.WEBHOOK_SECRET,
      trading: { transport: "grpc", address: production.TRADING_GRPC_URL },
      keycloak: { tokenUrl: production.KEYCLOAK_TOKEN_URL, clientId: "payments", clientSecret: "client-pw" },
      checkout: { successUrl: production.DEPOSIT_SUCCESS_URL, cancelUrl: production.DEPOSIT_CANCEL_URL },
      auth: { audience: "chance", rolesClaim: "realm_access.roles", tenantClaim: "organization" },
      outboxPollMs: 300,
      streamMaxAgeDays: 30,
      jobPollMs: 1000,
      shutdownDelayMs: 5000,
    });
  });

  it("names every missing setting of a production run at once, without printing a value", () => {
    const problems = problemsOf({});
    for (const name of ["DATABASE_URL", "NATS_URL", "PROVIDER_BASE_URL", "TRADING_GRPC_URL", "KEYCLOAK_TOKEN_URL", "DEPOSIT_SUCCESS_URL", "DEPOSIT_CANCEL_URL", "AUTH_JWKS_URL", "AUTH_ISSUER", "AUTH_AUDIENCE"]) {
      expect(problems.some((problem) => problem.startsWith(`${name} is required`)), name).toBe(true);
    }
    expect(problems.join("\n")).not.toContain("provider-api-key-value");
  });

  describe("the transport of trading's debit (REQ-17)", () => {
    const withoutGrpc = { ...production, TRADING_GRPC_URL: undefined };
    const withoutRest = { ...production, TRADING_BASE_URL: undefined };

    it("defaults to gRPC: TRADING_GRPC_URL is required and TRADING_BASE_URL is not", () => {
      expect(loadConfig(withoutRest).trading).toEqual({ transport: "grpc", address: "trading:8082" });
      expect(problemsOf(withoutGrpc)).toEqual([expect.stringMatching(/^TRADING_GRPC_URL is required .*TRADING_DEBIT_TRANSPORT=grpc/)]);
    });

    it("rest needs TRADING_BASE_URL and not TRADING_GRPC_URL; the value is read in any letter case", () => {
      expect(loadConfig({ ...withoutGrpc, TRADING_DEBIT_TRANSPORT: "REST" }).trading).toEqual({ transport: "rest", baseUrl: production.TRADING_BASE_URL });
      expect(problemsOf({ ...withoutRest, TRADING_DEBIT_TRANSPORT: "rest" })).toEqual([expect.stringMatching(/^TRADING_BASE_URL is required .*TRADING_DEBIT_TRANSPORT=rest/)]);
      expect(problemsOf({ ...production, TRADING_DEBIT_TRANSPORT: "graphql" })).toEqual(["TRADING_DEBIT_TRANSPORT must be one of: grpc, rest"]);
    });

    it("takes host:port with a name, an IPv4 or a bracketed IPv6 address, and refuses a scheme, a missing or out-of-range port", () => {
      for (const address of ["trading:8082", "trading.chance.svc.cluster.local:8082", "192.0.2.10:1", "[::1]:65535"]) {
        expect(loadConfig({ ...production, TRADING_GRPC_URL: address }).trading, address).toEqual({ transport: "grpc", address });
      }
      for (const address of ["http://trading:8082", "trading", "trading:0", "trading:65536", "trading:80a", "-trading:8082", "trading:8082/x", "user@trading:8082"]) {
        expect(problemsOf({ ...production, TRADING_GRPC_URL: address }), address).toEqual([expect.stringContaining("TRADING_GRPC_URL must be host:port")]);
      }
    });

    it("still checks the address of the transport that is not in use, so a switch back finds it valid", () => {
      expect(problemsOf({ ...production, TRADING_BASE_URL: "trading:8081" })).toEqual([expect.stringContaining("TRADING_BASE_URL must be a URL")]);
      expect(problemsOf({ ...production, TRADING_DEBIT_TRANSPORT: "rest", TRADING_GRPC_URL: "http://trading:8082" })).toEqual([expect.stringContaining("TRADING_GRPC_URL must be host:port")]);
    });

    it("leaves a local run without the address on the in-memory trading", () => {
      expect(loadConfig({ APP_ENV: "local", TRADING_BASE_URL: "http://trading:8081" }).trading).toBeNull();
      expect(loadConfig({ APP_ENV: "local", TRADING_GRPC_URL: "trading:8082" }).trading).toEqual({ transport: "grpc", address: "trading:8082" });
    });
  });

  it("allows a local run with nothing set: memory, fakes and local token settings", () => {
    const config = loadConfig({ APP_ENV: "local" });
    expect(config).toMatchObject({
      isLocal: true,
      databaseUrl: null,
      natsUrl: null,
      provider: null,
      webhookSecret: null,
      trading: null,
      keycloak: null,
      shutdownDelayMs: 0,
      auth: { issuer: "http://localhost:8081/realms/chance", audience: "chance" },
    });
    expect(config.checkout.successUrl).toMatch(/^http:\/\/localhost/);
  });

  it("keeps the provider settings together: a URL needs the key and the webhook secret", () => {
    expect(problemsOf({ ...production, PROVIDER_API_KEY: "" })).toEqual(["PROVIDER_API_KEY is required when PROVIDER_BASE_URL is set"]);
    expect(problemsOf({ ...production, WEBHOOK_SECRET: "" })).toEqual(["WEBHOOK_SECRET is required when PROVIDER_BASE_URL is set"]);
    expect(problemsOf({ APP_ENV: "local", PROVIDER_BASE_URL: "http://localhost:8082" })).toEqual([
      "PROVIDER_API_KEY is required when PROVIDER_BASE_URL is set",
      "WEBHOOK_SECRET is required when PROVIDER_BASE_URL is set",
    ]);
  });

  it("keeps the Keycloak settings together and defaults the client to payments", () => {
    expect(problemsOf({ ...production, KEYCLOAK_CLIENT_SECRET: "" })).toEqual([
      "KEYCLOAK_CLIENT_SECRET is required when KEYCLOAK_TOKEN_URL is set",
    ]);
    expect(loadConfig({ ...production, KEYCLOAK_CLIENT_ID: "other" }).keycloak?.clientId).toBe("other");
  });

  it("refuses a URL with the wrong scheme or with a user name, and a return URL that is no URL", () => {
    expect(problemsOf({ ...production, DATABASE_URL: "mysql://db/payments" })).toEqual([expect.stringContaining("DATABASE_URL must be a URL starting with postgres://")]);
    expect(problemsOf({ ...production, PROVIDER_BASE_URL: "http://user:secret@provider" })).toEqual([expect.stringContaining("PROVIDER_BASE_URL must be a URL")]);
    expect(problemsOf({ ...production, DEPOSIT_SUCCESS_URL: "javascript:alert(1)" })).toEqual([expect.stringContaining("DEPOSIT_SUCCESS_URL must be a URL")]);
    expect(problemsOf({ ...production, DEPOSIT_CANCEL_URL: "not a url" })).toEqual([expect.stringContaining("DEPOSIT_CANCEL_URL must be a URL")]);
    expect(problemsOf({ ...production, TRADING_BASE_URL: "ftp://trading" })).toEqual([expect.stringContaining("TRADING_BASE_URL must be a URL")]);
  });

  it("reads the runtime keys as startup values: the log level and the force-payout-failure flag", () => {
    expect(loadConfig({ ...production, LOG_LEVEL: "debug", FORCE_PAYOUT_FAILURE: "TRUE" })).toMatchObject({ logLevel: "debug", forcePayoutFailure: true });
    expect(loadConfig({ ...production, FORCE_PAYOUT_FAILURE: "false" }).forcePayoutFailure).toBe(false);
    expect(loadConfig({ ...production, LOG_LEVEL: "debug", FORCE_PAYOUT_FAILURE: "true" }).runtimeKeysFromEnv).toEqual(["forcePayoutFailure", "logLevel"]);
    expect(loadConfig(production).runtimeKeysFromEnv).toEqual([]);
    expect(problemsOf({ ...production, LOG_LEVEL: "loud" })).toEqual([expect.stringContaining("LOG_LEVEL must be one of")]);
    expect(problemsOf({ ...production, FORCE_PAYOUT_FAILURE: "yes" })).toEqual(["FORCE_PAYOUT_FAILURE must be true or false"]);
  });

  it("reads the watched config file and how often it is polled", () => {
    const config = loadConfig({ ...production, RUNTIME_CONFIG_DIR: "/etc/payments", RUNTIME_CONFIG_POLL_MS: "5000" });
    expect(config).toMatchObject({ runtimeConfigDir: "/etc/payments", runtimeConfigPollMs: 5000 });
    expect(problemsOf({ ...production, RUNTIME_CONFIG_POLL_MS: "10" })).toEqual(["RUNTIME_CONFIG_POLL_MS must be an integer from 1000 to 3600000"]);
  });

  it("seeds local tenants only in a local run, and only with valid tenant ids", () => {
    const first = "018f3c1e-7a00-7000-8000-0000000000aa";
    const second = "018f3c1e-7a00-7000-8000-0000000000bb";
    expect(loadConfig({ APP_ENV: "local", LOCAL_TENANT_IDS: ` ${first}, ${second} ` }).localTenantIds).toEqual([first, second]);
    expect(loadConfig({ APP_ENV: "local" }).localTenantIds).toEqual([]);
    expect(problemsOf({ ...production, LOCAL_TENANT_IDS: first })).toEqual(["LOCAL_TENANT_IDS may only be set with APP_ENV=local"]);
    expect(problemsOf({ APP_ENV: "local", LOCAL_TENANT_IDS: "not-a-uuid" })).toEqual(["LOCAL_TENANT_IDS must be a comma-separated list of tenant ids (UUIDs)"]);
  });

  it("checks the integer settings against their ranges", () => {
    expect(problemsOf({ ...production, PORT: "0" })).toEqual(["PORT must be an integer from 1 to 65535"]);
    expect(problemsOf({ ...production, PORT: "80.5" })).toEqual(["PORT must be an integer from 1 to 65535"]);
    expect(problemsOf({ ...production, DATABASE_POOL_MAX: "100" })).toEqual(["DATABASE_POOL_MAX must be an integer from 1 to 50"]);
    expect(problemsOf({ ...production, OUTBOX_POLL_MS: "1" })).toEqual(["OUTBOX_POLL_MS must be an integer from 50 to 60000"]);
    expect(problemsOf({ ...production, JOB_POLL_MS: "abc" })).toEqual(["JOB_POLL_MS must be an integer from 50 to 60000"]);
    expect(problemsOf({ ...production, STREAM_MAX_AGE_DAYS: "366" })).toEqual(["STREAM_MAX_AGE_DAYS must be an integer from 1 to 365"]);
    expect(loadConfig({ ...production, STREAM_MAX_AGE_DAYS: "45" })).toMatchObject({ streamMaxAgeDays: 45 });
    expect(loadConfig({ ...production, JOB_POLL_MS: "250", PORT: "9000" })).toMatchObject({ jobPollMs: 250, port: 9000 });
  });

  describe("METRICS_PORT (the listener that serves GET /metrics)", () => {
    it("defaults to 9464, also in local mode", () => {
      expect(loadConfig(production).metricsPort).toBe(9464);
      expect(loadConfig({ APP_ENV: "local" }).metricsPort).toBe(9464);
    });

    it("takes a port from 1 to 65535", () => {
      expect(loadConfig({ ...production, METRICS_PORT: "9100" }).metricsPort).toBe(9100);
      expect(loadConfig({ ...production, METRICS_PORT: "1" }).metricsPort).toBe(1);
      expect(loadConfig({ ...production, METRICS_PORT: "65535" }).metricsPort).toBe(65_535);
    });

    it.each(["0", "65536", "-1", "9464.5", "abc"])("rejects %s", (value) => {
      expect(problemsOf({ ...production, METRICS_PORT: value })).toEqual(["METRICS_PORT must be an integer from 1 to 65535"]);
    });

    it("must differ from PORT: the API port never serves /metrics", () => {
      const problem = "METRICS_PORT must differ from PORT (the API port never serves /metrics)";
      expect(problemsOf({ ...production, PORT: "9000", METRICS_PORT: "9000" })).toEqual([problem]);
      expect(problemsOf({ ...production, PORT: "9464" })).toEqual([problem]);
      expect(loadConfig({ ...production, PORT: "9464", METRICS_PORT: "9465" })).toMatchObject({ port: 9464, metricsPort: 9465 });
    });
  });

  it("limits the drain delay to what fits the chart's 30 seconds", () => {
    expect(loadConfig({ ...production, SHUTDOWN_DELAY_MS: String(MAX_SHUTDOWN_DELAY_MS) }).shutdownDelayMs).toBe(MAX_SHUTDOWN_DELAY_MS);
    expect(problemsOf({ ...production, SHUTDOWN_DELAY_MS: String(MAX_SHUTDOWN_DELAY_MS + 1) })).toEqual([`SHUTDOWN_DELAY_MS must be an integer from 0 to ${MAX_SHUTDOWN_DELAY_MS}`]);
  });

  it("refuses an APP_ENV that is not lowercase words", () => {
    expect(problemsOf({ ...production, APP_ENV: "Prod!" })).toEqual(["APP_ENV must be lowercase letters, digits and dashes"]);
  });

  it("does not take the token settings from a local default outside a local run", () => {
    expect(problemsOf({ ...production, AUTH_ISSUER: "" })).toEqual([expect.stringContaining("AUTH_ISSUER is required")]);
    expect(loadConfig({ ...production, AUTH_ROLES_CLAIM: "roles", AUTH_TENANT_CLAIM: "tenant" }).auth).toMatchObject({ rolesClaim: "roles", tenantClaim: "tenant" });
  });
});
