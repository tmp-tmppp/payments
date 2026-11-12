import { join } from "node:path";
import { createRemoteJWKSet } from "jose";
import type pg from "pg";
import { MemoryEventPublisher } from "./adapters/memory/memory-publisher.js";
import { FakePaymentProvider } from "./adapters/memory/fake-provider.js";
import { FakeTrading } from "./adapters/memory/fake-trading.js";
import { MemoryStore } from "./adapters/memory/memory-store.js";
import { createMetrics, startMetricsServer } from "./adapters/metrics/metrics.js";
import { tenantOfRequest } from "./web/auth.js";
import { NatsEventConsumer } from "./adapters/nats/nats-event-consumer.js";
import { NatsEventPublisher } from "./adapters/nats/nats-event-publisher.js";
import { OutboxRelay } from "./adapters/outbox/relay.js";
import { runMigrations } from "./adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { DAY_MS, idRetentionMs } from "./adapters/retention.js";
import { PaymentProviderClient } from "./adapters/provider/payment-provider-client.js";
import { ClientCredentialsTokenSource } from "./adapters/keycloak/client-credentials-token.js";
import { TradingClient } from "./adapters/trading/trading-client.js";
import { TradingGrpcClient } from "./adapters/trading/trading-grpc-client.js";
import { JobRunner } from "./adapters/jobs/job-runner.js";
import { randomIds, systemClock } from "./adapters/system.js";
import { RuntimeConfig } from "./adapters/config/runtime-config.js";
import { ConfigError, LOG_LEVELS, RUNTIME_CONFIG_FILE_NAME, loadConfig } from "./config.js";
import { CONSUMED_EVENTS } from "./domain/events.js";
import { createLogger } from "./logger.js";
import { createShutdown } from "./shutdown.js";
import { createUseCases } from "./usecases/application.js";
import { TENANT_CREATED_CONSUMER, WITHDRAWAL_REFUNDED_CONSUMER, tenantCreatedHandler, withdrawalRefundedHandler } from "./usecases/consumers.js";
import type { EventPublisher, PaymentProvider, PaymentsDeps, Store, Trading } from "./usecases/ports.js";
import { buildApp } from "./web/app.js";

// Composition root: configuration -> adapters -> use cases -> web application, jobs and consumers. Nothing else wires
// things together. Only APP_ENV=local may fall back to in-memory adapters (loadConfig has refused anything else).

const MIGRATION_ATTEMPTS = 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  logger.info({ appEnv: config.appEnv }, "Starting payments");

  // Adapters. Without a setting, only APP_ENV=local falls back to memory; loadConfig has refused anything else.
  let store: Store;
  let pool: pg.Pool | null = null;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl, config.databasePoolMax);
    pool.on("error", (error) => logger.error({ err: error }, "An idle database connection failed"));
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runMigrations(pool, logger);
        break;
      } catch (error) {
        if (attempt >= MIGRATION_ATTEMPTS) throw error;
        logger.warn({ attempt, err: error }, "The database is not ready for migrations, trying again");
        await sleep(3000);
      }
    }
    store = new PostgresStore(pool, logger);
  } else {
    logger.warn({}, "DATABASE_URL is not set: keeping all data in memory (APP_ENV=local)");
    store = new MemoryStore();
  }
  // A local run has no broker to deliver TenantCreated: the tenants named in LOCAL_TENANT_IDS get their schema at start.
  for (const tenantId of config.localTenantIds) {
    await store.transaction((repositories) => repositories.tenants.provision(tenantId, systemClock.now()));
    logger.info({ tenantId }, "Local tenant provisioned");
  }

  let publisher: EventPublisher;
  let nats: NatsEventPublisher | null = null;
  if (config.natsUrl) {
    nats = new NatsEventPublisher(config.natsUrl, logger, config.streamMaxAgeDays * DAY_MS);
    publisher = nats;
    // The service starts without the broker; events wait in the outbox until it answers.
    nats.ready().catch((error: unknown) => logger.warn({ err: error }, "NATS is not reachable yet; events wait in the outbox"));
  } else {
    logger.warn({}, "NATS_URL is not set: events are only logged (APP_ENV=local)");
    publisher = new MemoryEventPublisher(logger);
  }

  // Runtime keys (ADR-037): defaults, then the mounted file (re-read on change and on a poll), then the environment, which wins. The log level is
  // applied here; the force-payout-failure flag is read through `runtimeConfig` by the code that sends payouts.
  const runtimeConfig = new RuntimeConfig({
    filePath: config.runtimeConfigDir === null ? null : join(config.runtimeConfigDir, RUNTIME_CONFIG_FILE_NAME),
    pollMs: config.runtimeConfigPollMs,
    startup: { forcePayoutFailure: config.forcePayoutFailure, logLevel: config.logLevel },
    fromEnv: config.runtimeKeysFromEnv,
    validLogLevels: LOG_LEVELS,
    logger,
    onLogLevel: (level) => {
      logger.level = level;
    },
  });
  await runtimeConfig.start();

  // The payment provider and trading: the real clients, or in-memory fakes in a local run.
  let provider: PaymentProvider;
  if (config.provider) {
    provider = new PaymentProviderClient({ baseUrl: config.provider.baseUrl, apiKey: config.provider.apiKey });
  } else {
    logger.warn({}, "PROVIDER_BASE_URL is not set: using an in-memory payment provider (APP_ENV=local)");
    provider = new FakePaymentProvider();
  }
  // Trading's debit over gRPC (REQ-17, the default) or REST (TRADING_DEBIT_TRANSPORT=rest); the gRPC channel is closed on shutdown.
  let trading: Trading;
  let grpcTrading: TradingGrpcClient | null = null;
  if (config.trading && config.keycloak) {
    const tokens = new ClientCredentialsTokenSource(config.keycloak);
    if (config.trading.transport === "grpc") {
      grpcTrading = new TradingGrpcClient({ address: config.trading.address, tokens });
      trading = grpcTrading;
    } else {
      trading = new TradingClient({ baseUrl: config.trading.baseUrl, tokens });
    }
    logger.info({ transport: config.trading.transport }, "Debits at trading go over this transport");
  } else {
    logger.warn({}, "The trading address of TRADING_DEBIT_TRANSPORT (TRADING_GRPC_URL or TRADING_BASE_URL) or KEYCLOAK_TOKEN_URL is not set: using an in-memory trading (APP_ENV=local)");
    trading = new FakeTrading();
  }

  const deps: PaymentsDeps = { store, clock: systemClock, ids: randomIds, logger, provider, trading, settings: runtimeConfig, checkout: config.checkout };
  const useCases = createUseCases(deps);
  const jobs = new JobRunner({ deps, pollMs: config.jobPollMs, retentionMs: idRetentionMs(config.streamMaxAgeDays) });
  // Durable consumers with an inbox: TenantCreated creates the tenant's schema; WithdrawalRefunded ends the saga. They never
  // hold back the start: a missing stream or an unreachable broker is retried in the background.
  const consumer = config.natsUrl
    ? new NatsEventConsumer(config.natsUrl, logger, [
        {
          stream: CONSUMED_EVENTS.tenantCreated.stream,
          durable: TENANT_CREATED_CONSUMER,
          filterSubject: `${CONSUMED_EVENTS.tenantCreated.subjectPrefix}.*`,
          handler: tenantCreatedHandler(deps),
        },
        {
          stream: CONSUMED_EVENTS.withdrawalRefunded.stream,
          durable: WITHDRAWAL_REFUNDED_CONSUMER,
          filterSubject: `${CONSUMED_EVENTS.withdrawalRefunded.subjectPrefix}.*`,
          handler: withdrawalRefundedHandler(deps),
        },
      ])
    : null;

  // True from the first SIGTERM on; the readiness probe reads it.
  let shuttingDown = false;

  // Request metrics; the tenant label is the tenant of the verified token (request.auth is set only after the check).
  const metrics = createMetrics({ tenantOf: tenantOfRequest });

  const app = buildApp({
    logger,
    metrics,
    auth: {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      getKey: createRemoteJWKSet(new URL(config.auth.jwksUrl), { timeoutDuration: 3000 }),
      rolesClaim: config.auth.rolesClaim,
      tenantClaim: config.auth.tenantClaim,
    },
    health: { ping: () => store.ping(), isDraining: () => shuttingDown },
    useCases,
    webhook: { secret: config.webhookSecret, nowSeconds: () => Math.floor(Date.now() / 1000) },
  });
  // Background loops: the relay publishes the outbox; the jobs expire and reconcile deposits, repeat debits and send payouts.
  const relay = new OutboxRelay({ store, publisher, clock: systemClock, logger, pollMs: config.outboxPollMs, retentionMs: config.streamMaxAgeDays * DAY_MS });

  // GET /metrics has a listener of its own: the API port never serves it, so the gateway can never route it.
  const metricsServer = await startMetricsServer(metrics.registry, { port: config.metricsPort });
  logger.info({ port: metricsServer.port }, "Serving metrics");
  await app.listen({ host: "0.0.0.0", port: config.port });
  relay.start();
  jobs.start();
  consumer?.start();

  // Graceful shutdown (SIGTERM from Kubernetes, SIGINT from a terminal): src/shutdown.ts has the order and the timing.
  const shutdown = createShutdown(
    {
      drain: () => {
        shuttingDown = true;
      },
      closeServer: async () => {
        await app.close();
        await metricsServer.close();
      },
      stopRelay: () => relay.stop(),
      stopJobs: async () => {
        runtimeConfig.stop();
        await consumer?.stop();
        await jobs.stop();
        // The server and the jobs, the only callers of trading, have stopped.
        grpcTrading?.close();
      },
      closeEvents: async () => {
        await nats?.close();
      },
      closeDatabase: async () => {
        await pool?.end();
      },
    },
    { logger, delayMs: config.shutdownDelayMs, exit: (code) => process.exit(code) },
  );
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("payments failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
