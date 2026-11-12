# Contracts of the payments service

The contracts are written first and the code follows them. Tests fail when the two differ.

| File | What it says |
|---|---|
| `openapi.yaml` | OpenAPI 3.1: deposits, withdrawals, the provider webhook, the health probes, the bearer JWT scheme, `application/problem+json` errors, `Idempotency-Key`, the `201`, `202`, `409` and `503` (with `Retry-After`) cases |
| `asyncapi.yaml` | AsyncAPI 3.0: the four events the service publishes (DepositSucceeded, DepositFailed, WithdrawalSucceeded, WithdrawalFailed) and the two it consumes (TenantCreated, WithdrawalRefunded) |
| `trading-debit.openapi.yaml` | **Proposal.** The debit call that payments makes to trading in the withdrawal saga, over REST (`TRADING_DEBIT_TRANSPORT=rest`) |
| `external/trading-debit.proto` | trading's contract of the same debit over gRPC (REQ-17), the default transport; a copy, see below |

## Copies of the other services' contracts

payments is built on its own, so the code and the tests read these copies; the image ships the proto beside the compiled
code (`contracts/external/` in the Dockerfile), because the gRPC client loads it at start. They are plain copies, no
header added, so that `cmp` compares them with their source. `tests/contracts/trading-debit-proto.test.ts` checks the
hash below and, when trading's repository is checked out beside this one, that the copy still equals its source.

| Copy | Source (in the workspace, relative to this repository) | SHA-256 at the time of copying (2026-11-11) |
|---|---|---|
| `external/trading-debit.proto` | `../trading/contracts/trading-debit.proto` | `c9400faf2d2b6cf2fca951315da704f131159f71c9a9931a09dd52efd3a5c671` |

When trading changes its proto, copy the file again, update its hash here and run `npm test`. A field or status that
changed is then a change of `src/adapters/trading/trading-grpc-client.ts` and its tests.

## Money

**1 credit = 1 EUR cent.** Every amount, everywhere (the API, the database, the events, the debit call to trading and
the call to the payment provider), is one positive integer named `amount`, from 1 to 1 000 000. There is no currency
field and no conversion: the provider is always called in `EUR`, and its cents are our credits.

## For the authors of consuming services

- **Where.** NATS JetStream, stream `PAYMENTS` (subjects `chance.payments.>`). One subject per event and tenant:
  `chance.payments.<Event>.<tenantId>`, for example `chance.payments.DepositSucceeded.<tenantId>`. Subscribe with a
  wildcard (`chance.payments.DepositSucceeded.*`) or per event type.
- **Format.** CloudEvents 1.0 in structured JSON mode: the message body is the whole event (`specversion`, `id`,
  `source`, `type`, `subject`, `time`, `datacontenttype`, `data`) with the extension attributes `tenantid`,
  `correlationid` and `causationid`.
- **Delivery is at least once.** Deduplicate by the event `id` (a UUIDv7, also sent in the NATS header `Nats-Msg-Id`):
  store it in the same transaction as your change and skip a repeat.
- **Order.** Events are published in the order they were written, per publisher. Do not depend on order between
  different tenants.
- **Tenant.** Take the tenant from `tenantid`, never from the payload alone.
- **Ignore unknown fields.** New fields are added as optional ones. A breaking change gets a new type
  (`...DepositSucceeded.v2`) and is published next to the old one for a while.
- **Types.** `si.chance.payments.DepositSucceeded.v1`, `si.chance.payments.DepositFailed.v1`,
  `si.chance.payments.WithdrawalSucceeded.v1`, `si.chance.payments.WithdrawalFailed.v1`.
- **No personal data.** Events carry ids and amounts. User names and e-mails are never in them.

| Event | Who acts on it | What to do |
|---|---|---|
| `DepositSucceeded` (`depositId`, `tenantId`, `userId`, `amount`, `succeededAt`) | trading, audit | Credit `amount` to the user's balance, once per `depositId` |
| `DepositFailed` (`..., reason`: `declined`, `expired` or `provider_unavailable`) | audit | Record it |
| `WithdrawalSucceeded` (`withdrawalId`, `tenantId`, `userId`, `amount`, `paidOutAt`) | audit | Record the completed payout |
| `WithdrawalFailed` (`..., reason`: `forced`, `declined` or `payout_lost`) | trading, audit | Compensation: refund the debited `amount` to the user in one local transaction, once per `withdrawalId`, and publish `WithdrawalRefunded` |

## Proposals for the owner of trading

Two things payments needs from trading are **proposals**: payments is built and tested against them, but trading has not
agreed to them yet. Change them together or not at all.

### Proposal 1: the debit call (`trading-debit.openapi.yaml`)

`POST /v1/internal/debits` with `{withdrawalId, tenantId, userId, amount}`.

- **Idempotent by `withdrawalId`:** a repeat answers the same result and debits nothing again. Payments repeats the
  call after a timeout until it gets a definitive answer.
- `200` when the credits are debited, `409` (code `insufficient_credits`) when the user has too few. A debit that was
  made is never turned into a `409` by a later repeat.
- Caller authentication: the Keycloak client-credentials token of the client `payments` (audience `chance`).
- The route is internal; the gateway does not route `/v1/internal`.
- **gRPC (REQ-17).** The same debit over gRPC is trading's own contract, `external/trading-debit.proto`
  (`chance.trading.v1.Debits/DebitCredits` on `trading:8082`, plain HTTP/2), and the default transport of payments
  (`TRADING_DEBIT_TRANSPORT=grpc`, `TRADING_GRPC_URL`). Both transports share trading's idempotency store, and payments
  maps both to the same outcomes:

| gRPC status (trailing `chance-problem-code`) | REST | Outcome in payments |
|---|---|---|
| `OK` with `DEBIT_STATUS_DEBITED`, the same `withdrawal_id` and `amount` | `200` | `debited` (another id, amount or status: `unknown`) |
| `FAILED_PRECONDITION` (`insufficient_credits`) | `409` | `insufficient`; a `FAILED_PRECONDITION` without that code, or with another one (trading maps every conflict to it), is `unknown`, while REST takes every `409` as `insufficient` (the proposal's only `409`) |
| `UNAUTHENTICATED` | `401` | one new token and one repeat; a second one is `unknown` |
| `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL`, `CANCELLED`, `UNKNOWN`, `ABORTED` | `5xx`, timeout, network | repeated with backoff inside the call (trading's `retry-after` is honoured when it also sent `chance-problem-code`, up to 5 s; a longer one leaves the repeat to the job), then `unknown` |
| `ALREADY_EXISTS`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, any other | `400`, `403`, `422` | `unknown` without a repeat inside the call: the withdrawal stays `requested` and the job tries again later |

Every gRPC call carries `authorization: Bearer <token>`, the caller's `x-correlation-id` and a deadline of the attempt's
timeout (3 s); the circuit breaker and the retry policy are the ones of the REST client. An attempt given up while its
token was on the way sends nothing. The channel pings an open connection at the start of a call once 20 s have passed
since the last ping (never while it is idle) and drops it after 5 s without an answer, so a trading Pod that vanished
without closing its connections is replaced within one debit. REQ-17 leaves `trading-debit.openapi.yaml` itself
unchanged: it stays byte-equal to trading's copy `external/payments-trading-debit.openapi.yaml`.

### Proposal 2: the event WithdrawalRefunded (`asyncapi.yaml`)

When trading has refunded the credits of a withdrawal that payments reported as failed, it publishes `WithdrawalRefunded`:

| | |
|---|---|
| Stream | `TRADING` (subjects `chance.trading.>`) |
| Subject | `chance.trading.WithdrawalRefunded.<tenantId>` |
| Type | `si.chance.trading.WithdrawalRefunded.v1` |
| Data | `{withdrawalId, userId, amount}` |

Payments consumes it with a durable consumer and an inbox, and marks the withdrawal `refunded`. Payments starts while
the stream `TRADING` does not exist yet (it retries and logs), so the order of the two deployments does not matter.

## The payment provider

The provider's own contract is in the repository of the mock payment provider (`contracts/README.md` there): checkout
sessions, payouts, the thin signed webhook and the signature test vector. Payments calls it with the API key from its
Secret, an `Idempotency-Key` equal to the deposit or withdrawal id, and only its own fixed return URLs.
