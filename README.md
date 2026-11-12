# payments

The payments service of **Chance** (SVC-PAY): deposits and withdrawals of credits through an external payment API, and
the withdrawal saga with its refund. It is built from the tenants service (ADR-053), so it has the same layout, the same
conventions and the same tooling: one PostgreSQL schema per tenant plus a shared one, a transactional outbox, RFC 9457
errors, health probes, and Clean Architecture layers enforced by ESLint.

## Money

1 credit = 1 EUR cent. Every amount (API, database, events, the debit call to trading and the call to the provider) is one
positive integer named `amount`, from 1 to 1 000 000; the provider is always called in `EUR`. There is no conversion.

## API

Contract: [`contracts/openapi.yaml`](contracts/openapi.yaml) (OpenAPI 3.1). Every endpoint except the webhook and the
probes needs a bearer token from the identity provider (always verified). The tenant and the user come from the token,
never from the URL or the body; another tenant's or user's id answers `404`.

| Method and path | Who | What |
|---|---|---|
| `POST /v1/deposits` | trader, tenant admin | Starts a deposit: asks the provider for a checkout session and returns the payment page's address. Needs `Idempotency-Key` |
| `GET /v1/deposits/{id}` | owner | The deposit: `pending`, `succeeded` or `failed` (reason `declined` or `expired`) |
| `POST /v1/withdrawals` | trader, tenant admin | Requests a withdrawal: debits trading, then pays out. Needs `Idempotency-Key` |
| `GET /v1/withdrawals/{id}` | owner | The withdrawal: `requested`, `debited`, `paid_out`, `rejected`, `failed` or `refunded` |
| `POST /v1/webhooks/payment-provider` | the provider | Public, raw body, `Provider-Signature` verified; see below |
| `GET /health/startup`, `/health/ready`, `/health/live` | Kubernetes | Probes; readiness checks the database and answers `503` as soon as the process gets SIGTERM |

- The same `Idempotency-Key` with the same body answers with the same resource; with another body it is `409`. The
  return addresses of the payment page (`DEPOSIT_SUCCESS_URL`, `DEPOSIT_CANCEL_URL`) are settings, never request input.
- `503` with `Retry-After` means "try again": the tenant has no schema yet, the provider is down, or trading's circuit is open.
- A withdrawal that trading refuses for too few credits answers `409`, and its status stays readable as `rejected`.
  When trading does not answer, the withdrawal stays `requested`, the call answers `202` with the status address, and a
  background job repeats the debit with the same key until trading answers.

## Flows

**Deposit (FL-B).** `POST /v1/deposits` stores a `pending` deposit and creates a checkout session (the deposit id is the
`Idempotency-Key` at the provider). The buyer pays on the provider's page. The provider sends a thin, signed webhook; payments
checks the signature (tolerance 300 s, constant time, any of several `v1`), stores the provider's event id in
`shared.provider_events` in the same transaction as the change, reads the session back and acts on its state, never on
the event type. A deposit is created in three steps with no database transaction open across the provider call (insert and
commit, create the session with the deposit id as Idempotency-Key, attach it); a provider outage leaves the deposit pending
without a link and the same key, or the job, finishes it. A pending deposit becomes `failed` only when the read-back of its
session shows `expired` or `declined` (or the provider no longer knows it, 404): reason `expired` or `declined`, a completed
session always wins and an open one keeps the deposit pending. The job reads the session back after 1, 2, 5, 10 and then every
20 minutes, and right after the session's own `expiresAt` when that comes sooner, so a lost webhook costs minutes and one
deposit does not cost a provider call a minute. A deposit that never got a session in 30 minutes fails with `provider_unavailable`.

**Withdrawal (FL-C).** `requested` -> `debited` (trading's gRPC `Debits/DebitCredits`, or `POST /v1/internal/debits` with
`TRADING_DEBIT_TRANSPORT=rest`; idempotent by withdrawal id) ->
`paid_out` (the provider's payout settles). Failure paths: `rejected` (409 from trading, or its circuit is open before any
call); `debited -> failed -> refunded` (the payout is declined; trading gives the credits back and publishes
`WithdrawalRefunded`). Payout destination is the user id (opaque, no bank data). A payout the provider no longer knows
(404) counts as lost and fails.

**Force payout failure.** The runtime key `forcePayoutFailure` (ADR-037) makes payments decline a new payout itself, before
the provider is called (reason `forced`), so the saga's compensation can be shown on demand. It lives in `runtime.json` in
the directory `RUNTIME_CONFIG_DIR`, which the chart mounts from a ConfigMap as a directory (never `subPath`); the file is
watched and also polled, and a change takes effect without a restart. The provider's own `declinePayouts` test mode stays
a second, independent way to make payouts fail.

## Events

Contract: [`contracts/asyncapi.yaml`](contracts/asyncapi.yaml); notes in [`contracts/README.md`](contracts/README.md).
CloudEvents 1.0 on NATS JetStream; events carry ids, never names or e-mails.

| Direction | Event | Stream and subject |
|---|---|---|
| publishes | `DepositSucceeded`, `DepositFailed`, `WithdrawalSucceeded`, `WithdrawalFailed` | `PAYMENTS`, `chance.payments.<Event>.<tenantId>` |
| consumes | `TenantCreated` | `TENANTS`: creates and migrates the tenant's schema, through an inbox |
| consumes | `WithdrawalRefunded` (a proposal for trading) | `TRADING`, `chance.trading.WithdrawalRefunded.<tenantId>`: marks the withdrawal `refunded` |

Events are written to an outbox in the transaction of the change and published by a relay (at least once; the event id
deduplicates). Consumers are durable and store the processed event id in the same transaction as their change. A missing
stream (`TRADING` before trading exists) never stops the start: the consumer logs and retries with a growing wait.

The debit call to trading ([`contracts/trading-debit.openapi.yaml`](contracts/trading-debit.openapi.yaml)) and
`WithdrawalRefunded` are **proposals** for trading's owner; until trading implements them, payments is tested against a
fake trading (an HTTP server in the tests, an in-memory one for `APP_ENV=local`).

**The debit over gRPC (REQ-17).** By default (`TRADING_DEBIT_TRANSPORT=grpc`) payments calls
`chance.trading.v1.Debits/DebitCredits` on `TRADING_GRPC_URL` (`trading:8082`, plain HTTP/2). The contract is trading's
own file, copied with its hash to [`contracts/external/trading-debit.proto`](contracts/external/trading-debit.proto) and
shipped in the image; `src/adapters/trading/trading-grpc-client.ts` loads it with `@grpc/proto-loader`. The call carries
the same client-credentials token (`authorization: Bearer ...`), the caller's `x-correlation-id` and a deadline of 3 s per
attempt, and has the REST client's retry, backoff and circuit breaker; trading's `retry-after` is honoured when trading
itself sent the status (with `chance-problem-code`). The outcomes are the same as over REST: OK is `debited`,
`FAILED_PRECONDITION` with `insufficient_credits` is `insufficient`, everything else is `unknown` (the job repeats it). The
status table is in [`contracts/README.md`](contracts/README.md). A keepalive ping (after 20 s, answer within 5 s, only while
calls run) drops a connection whose peer stopped answering. The channel is closed on shutdown; `TRADING_DEBIT_TRANSPORT=rest`
switches back to the REST endpoint. The tests run an in-process gRPC server built from the same proto.

## Layout

| Path | What it holds |
|---|---|
| `src/domain` | Deposit and withdrawal state machines, amounts, event builders, webhook signature; no framework |
| `src/usecases` | Ports, errors and the use cases (they depend on ports only) |
| `src/adapters` | PostgreSQL (migrations, tenant scope, store), NATS publisher and consumer, outbox relay, job runner, provider, trading and Keycloak token clients (cockatiel: timeout, retry with backoff and jitter, circuit breaker), runtime config watcher, the metrics module, in-memory adapters and fakes |
| `src/web` | Fastify routes, token verification, RFC 9457 problems, health probes |
| `src/main.ts` | The composition root |
| `migrations/shared`, `migrations/tenant` | SQL of the shared schema (outbox, inbox, provider events, tenant registry) and of every tenant schema (deposits, withdrawals) |
| `contracts` | OpenAPI, AsyncAPI, the two proposals, and in `external/` the copy of trading's gRPC proto; contract tests keep the code equal to them |
| `helm`, `Dockerfile`, `compose.yaml`, `.github` | Delivery and local dependencies |
| `scripts/e2e-local.mjs` | End to end run against a locally started provider (see below) |

At startup the migrations run under an advisory lock: the shared files once, then the tenant files for every tenant in
`shared.tenant_registry`, so schemas never drift apart. A new tenant's schema is created and migrated in the transaction
that stores the event `TenantCreated` in the inbox. One function selects a tenant schema (`tenant-scope.ts`), and a test
fails when any other file touches `search_path`. A request for a tenant without a schema answers `503` with `Retry-After`.

## Configuration

Environment variables, validated at startup (`src/config.ts`): production stops with a message that names every missing
or wrong setting (values are never printed). Only `APP_ENV=local` may leave the infrastructure ones out; it then keeps
data in memory, logs events and uses fakes.

| Variable | Secret | Meaning |
|---|---|---|
| `APP_ENV` | no | `local` allows in-memory fallbacks; anything else requires every setting |
| `PORT`, `LOG_LEVEL` | no | HTTP port (8080), log level (also a runtime key) |
| `METRICS_PORT` | no | Port (default `9464`, 1 to 65535) of the separate listener that serves `GET /metrics`; must differ from `PORT` (see "Metrics") |
| `DATABASE_URL`, `DATABASE_POOL_MAX` | URL: yes | PostgreSQL of the service |
| `NATS_URL` | no | NATS server with JetStream |
| `PROVIDER_BASE_URL` | no | Base address of the payment provider |
| `PROVIDER_API_KEY` | yes | The provider's API key (bearer token) |
| `WEBHOOK_SECRET` | yes | The secret that signs the provider's webhooks |
| `TRADING_DEBIT_TRANSPORT` | no | How the debit reaches trading (REQ-17): `grpc` (default) or `rest` |
| `TRADING_GRPC_URL` | no | Trading's gRPC address for `grpc`, `host:port` without a scheme (port 1 to 65535); the chart uses `trading:8082`. Required outside `APP_ENV=local` when the transport is `grpc` |
| `TRADING_BASE_URL` | no | Trading's base URL for `rest`; the chart and the compose file use `http://trading:8081`, trading's internal port. Required outside `APP_ENV=local` when the transport is `rest`; checked whenever it is set |
| `KEYCLOAK_TOKEN_URL` | no | Token endpoint of the realm, for the client-credentials token sent to trading |
| `KEYCLOAK_CLIENT_ID` | no | Default `payments` |
| `KEYCLOAK_CLIENT_SECRET` | yes | Secret of that client |
| `DEPOSIT_SUCCESS_URL`, `DEPOSIT_CANCEL_URL` | no | Fixed return addresses of the payment page |
| `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_ROLES_CLAIM`, `AUTH_TENANT_CLAIM` | no | Verification of user tokens (always verified). The token holds exactly one organization (`AUTH_TENANT_CLAIM`); its group `/tenant-admin` or `/trader` in `organization.<alias>.groups` is the role, and a `trader` or `tenant-admin` realm role (`AUTH_ROLES_CLAIM`) is ignored (token contract v2) |
| `RUNTIME_CONFIG_DIR`, `RUNTIME_CONFIG_POLL_MS` | no | Directory with `runtime.json` (`forcePayoutFailure`, `logLevel`) and how often it is also read (default 10 000 ms) |
| `FORCE_PAYOUT_FAILURE` | no | Startup value of the flag; the file wins over it |
| `OUTBOX_POLL_MS`, `JOB_POLL_MS`, `SHUTDOWN_DELAY_MS` | no | Loop intervals and the drain delay |
| `STREAM_MAX_AGE_DAYS` | no | Max age of the PAYMENTS stream and of published outbox rows (default 30, 1 to 365); processed event ids and webhook ids are kept one day longer (at least 30 days). The same value in every service, so a service started later still reads older events |
| `LOCAL_TENANT_IDS` | no | `APP_ENV=local` only: tenants whose schema is created at start |

In the cluster the Secret `payments-env` holds `DATABASE_URL`, `PROVIDER_API_KEY`, `WEBHOOK_SECRET` and
`KEYCLOAK_CLIENT_SECRET`; the other settings are in the chart's ConfigMap, and the runtime file is in a second ConfigMap
(`helm upgrade ... --set runtime.forcePayoutFailure=true` flips the flag without restarting the Pods).

`AUTH_ISSUER`, `DEPOSIT_SUCCESS_URL` and `DEPOSIT_CANCEL_URL` in `helm/values-prod.yaml` are empty on purpose: their values
(`https://<public host>/realms/chance`, `https://<public host>/deposits/success` and `.../deposits/cancelled`) come from
the pipeline's public host (plan INF-01). A deploy without them stops at start with "AUTH_ISSUER is required" and
"DEPOSIT_SUCCESS_URL is required" (the Pod restarts and the deploy rolls back) instead of answering every token with 401
or sending buyers back to localhost.

## Metrics

Rate, errors and duration of the HTTP API (REQ-20), in the Prometheus text format. The Node services of the platform
use the same names, labels and port (the convention agreed on 2026-11-11), so one dashboard can read them all; the module is
[`src/adapters/metrics/metrics.ts`](src/adapters/metrics/metrics.ts) (prom-client 15).

- **Endpoint.** `GET /metrics` on `METRICS_PORT` (default `9464`), a listener of its own: any other path there answers
  `404`, and the API port (`PORT`) never serves `/metrics`, so the gateway can never route it. The listener starts with
  the service and closes with it on shutdown (after the API server). The default is the same in every service, so
  services started natively on one host need a different `METRICS_PORT` each (in a cluster every Pod has its own
  address).
- **`http_requests_total`** (counter) and **`http_request_duration_seconds`** (histogram, the default buckets), both
  with the labels `method`, `route`, `status_code` and `tenant`. Errors are the `status_code` values 4xx and 5xx; the
  duration runs from the arrival of the request to the end of its response.
- **`route`** is the route template (`/v1/deposits/:id`), or `unmatched` for a request that matched no route (a 404), so
  a raw URL or an id never becomes a label value.
- **`tenant`** is the tenant id in the token the service verified (the money API), `none` when the request has no
  verified token (the provider's webhook, the probes, a rejected token) or the token names no tenant. It is never read
  from a header or the body.
- The default process metrics of prom-client (`process_*`, `nodejs_*`) are on the same registry.
- **Chart.** The Pod has a container port `metrics` and the annotations `prometheus.io/scrape: "true"`,
  `prometheus.io/port: "9464"` and `prometheus.io/path: /metrics` (the port is the chart value `metrics.port`, also
  rendered as `METRICS_PORT`; the Service does not expose it). With `networkPolicy.enabled`, the namespace
  `networkPolicy.metrics.namespace` (default `monitoring`) is admitted on that port.

## Run and test

```bash
npm ci
npm run lint
npm run typecheck
npm test                      # unit, web and contract tests; npm test -- --coverage for the 80 % gate
npm run test:integration      # PostgreSQL 18 and NATS in containers (needs a Docker daemon)
npm run build && npm start
docker compose up -d --build  # PostgreSQL, NATS, the mock provider and payments (compose.yaml explains the settings)
helm lint helm -f helm/values-prod.yaml && helm template payments helm -f helm/values-prod.yaml | kubeconform -strict
```

**Run it end to end** (no cluster, no identity provider; the two services run on one host, so each has its own `METRICS_PORT`): start PostgreSQL 18 and NATS (`docker compose up -d postgres nats`),
the mock provider (`APP_ENV=local PORT=8082 METRICS_PORT=9465 WEBHOOK_URL=http://127.0.0.1:8085/v1/webhooks/payment-provider npm start` in
`../payment-provider`) and payments (`APP_ENV=local PORT=8085 METRICS_PORT=9464 DATABASE_URL=... NATS_URL=... PROVIDER_BASE_URL=http://127.0.0.1:8082
PROVIDER_API_KEY=provider-local-api-key WEBHOOK_SECRET=provider-local-webhook-secret AUTH_JWKS_URL=http://127.0.0.1:8099/
RUNTIME_CONFIG_DIR=<a directory with runtime.json> npm start`, trading is the in-memory fake), then `PAYMENTS_URL=http://127.0.0.1:8085
RUNTIME_FILE=<that runtime.json> npm run e2e:local`. The script plays the identity provider (it serves a key set and signs tokens),
the tenants service, the buyer and trading, and walks through a deposit, a withdrawal that is paid out, a withdrawal
that fails by the flag, and its refund.
