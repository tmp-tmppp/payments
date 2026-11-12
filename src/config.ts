// Typed configuration from environment variables, validated once at startup. A bad or missing setting stops the
// start with a message that names every problem; values are never printed (they may hold passwords).
// ADR-037: the runtime keys (log level, force-payout-failure) are read here as the startup values (defaults, then env);
// the watcher of the mounted file (RUNTIME_CONFIG_DIR/runtime.json) overrides them while the service runs.

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

/** The file inside RUNTIME_CONFIG_DIR that holds the runtime keys. */
export const RUNTIME_CONFIG_FILE_NAME = "runtime.json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The external payment API (our own mock provider). Null only in local mode: an in-memory fake provider is used then. */
export interface ProviderConfig {
  baseUrl: string;
  /** Bearer API key of the one merchant (a Secret). */
  apiKey: string;
}

/** How payments calls trading's debit (REQ-17): gRPC (the default) or the REST endpoint of the proposal. */
export const TRADING_DEBIT_TRANSPORTS = ["grpc", "rest"] as const;
export type TradingDebitTransport = (typeof TRADING_DEBIT_TRANSPORTS)[number];

/**
 * Trading's debit: gRPC on `address` (host:port, contracts/external/trading-debit.proto) or REST under `baseUrl`
 * (contracts/trading-debit.openapi.yaml). Null only in local mode: a fake trading is used then.
 */
export type TradingConfig = { transport: "grpc"; address: string } | { transport: "rest"; baseUrl: string };

/** host:port with a host name, an IPv4 address or a bracketed IPv6 address; the port is checked for its range separately. */
const HOST_PORT = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*):([0-9]{1,5})$/;

/** The client "payments" of the identity provider: payments asks it for a client-credentials token for its calls to trading. */
export interface KeycloakConfig {
  /** The token endpoint of the realm, for example http://identity:8080/realms/chance/protocol/openid-connect/token. */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  jwksUrl: string;
  issuer: string;
  audience: string;
  rolesClaim: string;
  tenantClaim: string;
}

/** Where the provider sends the buyer after paying or declining. Fixed values: a request can never change them. */
export interface CheckoutConfig {
  successUrl: string;
  cancelUrl: string;
}

export interface Config {
  /** "local" allows in-memory fallbacks; any other value (default "production") requires every setting. */
  appEnv: string;
  isLocal: boolean;
  port: number;
  /** The port of the separate listener that serves GET /metrics; never the API port. */
  metricsPort: number;
  /** Startup value of a runtime key. */
  logLevel: string;
  /** Startup value of a runtime key: when true, payments declines every payout itself (reason "forced"). */
  forcePayoutFailure: boolean;
  /** The runtime keys the environment set explicitly (they win over the runtime file, ADR-037: defaults, file, environment). */
  runtimeKeysFromEnv: Array<"forcePayoutFailure" | "logLevel">;
  /** The directory the chart mounts from the ConfigMap (a directory mount, never subPath); its file `runtime.json` is watched. Null: nothing is watched. */
  runtimeConfigDir: string | null;
  /** Tenants provisioned at start; only with APP_ENV=local (a local run has no broker to deliver TenantCreated). */
  localTenantIds: string[];
  /** The file is re-read when it changes and also this often, because a ConfigMap update replaces the file by a link swap. */
  runtimeConfigPollMs: number;
  /** Null only in local mode: the service then keeps its data in memory. */
  databaseUrl: string | null;
  databasePoolMax: number;
  /** Null only in local mode: events are then logged instead of published. */
  natsUrl: string | null;
  provider: ProviderConfig | null;
  /** The secret that signs the provider's webhooks. Null only in local mode, together with provider. */
  webhookSecret: string | null;
  trading: TradingConfig | null;
  keycloak: KeycloakConfig | null;
  checkout: CheckoutConfig;
  auth: AuthConfig;
  outboxPollMs: number;
  /** The PAYMENTS stream's max age, also how long the outbox keeps a published row (decision of 2026-11-11). */
  streamMaxAgeDays: number;
  /** How often the background jobs (deposit expiry, debit retry, payouts) look for due work. */
  jobPollMs: number;
  /**
   * After SIGTERM the service first answers 503 on the readiness probe and keeps serving for this long, so that the
   * load balancer and the endpoints stop sending requests; only then does it close the server, the loops and the pools.
   */
  shutdownDelayMs: number;
}

/** The longest drain delay: with the 10 seconds a shutdown may then take, it ends inside the chart's 30 seconds. */
export const MAX_SHUTDOWN_DELAY_MS = 15_000;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

// Local defaults of the token settings, matching a Keycloak on port 8081 (see README). Tokens are always verified.
const LOCAL_AUTH = {
  jwksUrl: "http://localhost:8081/realms/chance/protocol/openid-connect/certs",
  issuer: "http://localhost:8081/realms/chance",
  audience: "chance",
};

const LOCAL_CHECKOUT = {
  successUrl: "http://localhost:3000/deposits/success",
  cancelUrl: "http://localhost:3000/deposits/cancelled",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const text = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`);
      return fallback;
    }
    return value;
  };
  const url = (name: string, protocols: readonly string[], value: string | undefined): string | null => {
    if (value === undefined) return null;
    try {
      const parsed = new URL(value);
      // The connection strings of the database and the broker carry credentials; every other URL must not (a return URL
      // with a user name is no place for one, and the provider's own contract forbids it).
      const credentialsAllowed = protocols.every((protocol) => !protocol.startsWith("http"));
      if (protocols.includes(parsed.protocol) && (credentialsAllowed || (parsed.username === "" && parsed.password === ""))) return value;
    } catch {
      // Reported below.
    }
    problems.push(`${name} must be a URL starting with ${protocols.map((p) => `${p}//`).join(" or ")}`);
    return null;
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = text(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (raw === "true") return true;
    if (raw === "false") return false;
    problems.push(`${name} must be true or false`);
    return fallback;
  };

  const appEnv = text("APP_ENV") ?? "production";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(appEnv)) problems.push("APP_ENV must be lowercase letters, digits and dashes");
  const isLocal = appEnv === "local";
  const required = (name: string, hint: string): string | undefined => {
    const value = text(name);
    if (value === undefined && !isLocal) problems.push(`${name} is required (${hint}); only APP_ENV=local may leave it out`);
    return value;
  };

  const logLevel = text("LOG_LEVEL") ?? "info";
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);

  const databaseUrl = url("DATABASE_URL", ["postgres:", "postgresql:"], required("DATABASE_URL", "the connection string of the service's PostgreSQL database"));
  const natsUrl = url("NATS_URL", ["nats:", "tls:"], required("NATS_URL", "the NATS server"));

  // The payment provider: URL, API key and webhook secret belong together; only a local run may have none of them.
  let provider: ProviderConfig | null = null;
  let webhookSecret: string | null = null;
  const providerUrl = required("PROVIDER_BASE_URL", "the base URL of the payment provider");
  if (providerUrl !== undefined) {
    const checkedUrl = url("PROVIDER_BASE_URL", ["http:", "https:"], providerUrl);
    const apiKey = text("PROVIDER_API_KEY");
    const secret = text("WEBHOOK_SECRET");
    if (!apiKey) problems.push("PROVIDER_API_KEY is required when PROVIDER_BASE_URL is set");
    if (!secret) problems.push("WEBHOOK_SECRET is required when PROVIDER_BASE_URL is set");
    if (checkedUrl && apiKey && secret) {
      provider = { baseUrl: checkedUrl, apiKey };
      webhookSecret = secret;
    }
  }

  // Trading's debit: the address of the chosen transport is required (outside a local run); the other one is checked only
  // when it is set, so that switching the transport back finds it valid.
  const transportText = text("TRADING_DEBIT_TRANSPORT")?.toLowerCase() ?? "grpc";
  const transport: TradingDebitTransport = transportText === "rest" ? "rest" : "grpc";
  if (!(TRADING_DEBIT_TRANSPORTS as readonly string[]).includes(transportText)) problems.push(`TRADING_DEBIT_TRANSPORT must be one of: ${TRADING_DEBIT_TRANSPORTS.join(", ")}`);
  const tradingUrl = url(
    "TRADING_BASE_URL",
    ["http:", "https:"],
    transport === "rest" ? required("TRADING_BASE_URL", "the base URL of trading, for TRADING_DEBIT_TRANSPORT=rest") : text("TRADING_BASE_URL"),
  );
  const grpcAddressText = transport === "grpc" ? required("TRADING_GRPC_URL", "trading's gRPC address host:port, for TRADING_DEBIT_TRANSPORT=grpc") : text("TRADING_GRPC_URL");
  let grpcAddress: string | null = null;
  if (grpcAddressText !== undefined) {
    const port = Number(HOST_PORT.exec(grpcAddressText)?.[1] ?? 0);
    if (port >= 1 && port <= 65535) grpcAddress = grpcAddressText;
    else problems.push("TRADING_GRPC_URL must be host:port with a port from 1 to 65535 (for example trading:8082), without a scheme");
  }
  let trading: TradingConfig | null = null;
  if (transport === "grpc" && grpcAddress !== null) trading = { transport, address: grpcAddress };
  if (transport === "rest" && tradingUrl !== null) trading = { transport, baseUrl: tradingUrl };

  let keycloak: KeycloakConfig | null = null;
  const keycloakTokenUrl = required("KEYCLOAK_TOKEN_URL", "the token endpoint of the realm, for the token payments sends to trading");
  if (keycloakTokenUrl !== undefined) {
    const checkedUrl = url("KEYCLOAK_TOKEN_URL", ["http:", "https:"], keycloakTokenUrl);
    const clientId = text("KEYCLOAK_CLIENT_ID") ?? "payments";
    const clientSecret = text("KEYCLOAK_CLIENT_SECRET");
    if (!clientSecret) problems.push("KEYCLOAK_CLIENT_SECRET is required when KEYCLOAK_TOKEN_URL is set");
    if (checkedUrl && clientSecret) keycloak = { tokenUrl: checkedUrl, clientId, clientSecret };
  }

  // Local runs only: tenants that exist from the start, because there is no TenantCreated event without a broker.
  const localTenantIds = (text("LOCAL_TENANT_IDS") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (localTenantIds.length > 0 && !isLocal) problems.push("LOCAL_TENANT_IDS may only be set with APP_ENV=local");
  if (localTenantIds.some((id) => !UUID.test(id))) problems.push("LOCAL_TENANT_IDS must be a comma-separated list of tenant ids (UUIDs)");

  const checkoutText = (name: string, local: string, hint: string): string => required(name, hint) ?? local;
  const successUrl = url("DEPOSIT_SUCCESS_URL", ["http:", "https:"], checkoutText("DEPOSIT_SUCCESS_URL", LOCAL_CHECKOUT.successUrl, "where the buyer goes after paying"));
  const cancelUrl = url("DEPOSIT_CANCEL_URL", ["http:", "https:"], checkoutText("DEPOSIT_CANCEL_URL", LOCAL_CHECKOUT.cancelUrl, "where the buyer goes after declining"));

  const authText = (name: string, local: string, hint: string): string => required(name, hint) ?? local;
  const jwksUrl = url("AUTH_JWKS_URL", ["http:", "https:"], authText("AUTH_JWKS_URL", LOCAL_AUTH.jwksUrl, "the JWKS URL of the identity provider"));
  const auth: AuthConfig = {
    jwksUrl: jwksUrl ?? LOCAL_AUTH.jwksUrl,
    issuer: authText("AUTH_ISSUER", LOCAL_AUTH.issuer, "the issuer (iss) of the tokens"),
    audience: authText("AUTH_AUDIENCE", LOCAL_AUTH.audience, "the audience (aud) of the tokens"),
    rolesClaim: text("AUTH_ROLES_CLAIM") ?? "realm_access.roles",
    tenantClaim: text("AUTH_TENANT_CLAIM") ?? "organization",
  };

  const port = integer("PORT", 8080, 1, 65535);
  const metricsPort = integer("METRICS_PORT", 9464, 1, 65535);
  // The API port never serves /metrics (so the gateway can never route it): the two listeners need two ports.
  if (metricsPort === port) problems.push("METRICS_PORT must differ from PORT (the API port never serves /metrics)");

  const config: Config = {
    appEnv,
    isLocal,
    port,
    metricsPort,
    logLevel,
    forcePayoutFailure: flag("FORCE_PAYOUT_FAILURE", false),
    runtimeKeysFromEnv: [...(text("FORCE_PAYOUT_FAILURE") === undefined ? [] : (["forcePayoutFailure"] as const)), ...(text("LOG_LEVEL") === undefined ? [] : (["logLevel"] as const))],
    runtimeConfigDir: text("RUNTIME_CONFIG_DIR") ?? null,
    localTenantIds,
    runtimeConfigPollMs: integer("RUNTIME_CONFIG_POLL_MS", 10_000, 1000, 3_600_000),
    databaseUrl,
    databasePoolMax: integer("DATABASE_POOL_MAX", 5, 1, 50),
    natsUrl,
    provider,
    webhookSecret,
    trading,
    keycloak,
    checkout: { successUrl: successUrl ?? LOCAL_CHECKOUT.successUrl, cancelUrl: cancelUrl ?? LOCAL_CHECKOUT.cancelUrl },
    auth,
    outboxPollMs: integer("OUTBOX_POLL_MS", 300, 50, 60_000),
    // Every service of the platform sets the same value, so a service started later still reads the older events.
    streamMaxAgeDays: integer("STREAM_MAX_AGE_DAYS", 30, 1, 365),
    jobPollMs: integer("JOB_POLL_MS", 1000, 50, 60_000),
    // Nobody routes traffic to a local run, so it does not wait.
    shutdownDelayMs: integer("SHUTDOWN_DELAY_MS", isLocal ? 0 : 5000, 0, MAX_SHUTDOWN_DELAY_MS),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
