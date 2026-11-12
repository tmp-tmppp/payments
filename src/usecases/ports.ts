import type { ReceivedEvent } from "../domain/consumed-events.js";
import type { Deposit } from "../domain/deposit.js";
import type { CloudEvent } from "../domain/events.js";
import type { Withdrawal } from "../domain/withdrawal.js";

// Ports: everything a use case needs from the outside world. Adapters implement them (ADR-001).
// Data lives in two places: the shared schema (outbox, inbox, provider events, tenant registry) and one schema per tenant
// (deposits, withdrawals). A use case that touches a tenant's rows goes through `Store.tenantTransaction`, which picks
// the schema from the tenant id in exactly one place of the adapter; it never writes a schema name itself.

/** Who is acting and which request it is, for the events a use case writes. */
export interface Caller {
  userId: string;
  correlationId: string;
  /** The id of the request that caused the work; it becomes "causationid" of the events. */
  causationId: string;
}

export interface OutboxMessage {
  /** Equals the id of the event; it is also the deduplication id on the broker. */
  id: string;
  aggregateId: string;
  /** NATS subject. */
  subject: string;
  type: string;
  /** The whole CloudEvent. */
  payload: CloudEvent<unknown>;
  createdAt: Date;
}

export interface OutboxRow extends OutboxMessage {
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  /**
   * Unpublished rows, oldest first, locked for this transaction. Only one instance publishes at a time, so that the
   * events of a tenant keep their order with several replicas: the claim takes a lock that is held until the end of
   * the transaction, and returns no rows when another transaction holds it. Call it inside a transaction.
   */
  claimBatch(limit: number): Promise<OutboxRow[]>;
  markPublished(id: string, at: Date): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  /** Deletes the rows published before `olderThan`; unpublished rows stay however old they are. Returns how many went. */
  purgePublished(olderThan: Date): Promise<number>;
}

/** The events this service consumed (ADR-053 inbox): the id is stored in the same transaction as the change it caused. */
export interface InboxRepository {
  /** Records the event for the consumer. False when it was recorded before: the redelivery must change nothing. */
  markProcessed(consumer: string, event: { id: string; type: string }, at: Date): Promise<boolean>;
  /** Deletes the records older than `olderThan`. Returns how many went. */
  purgeProcessed(olderThan: Date): Promise<number>;
}

/** The webhooks of the payment provider that were processed; the provider delivers at least once. */
export interface ProviderEventRepository {
  /** Records the event id. False when it was recorded before: the redelivery must change nothing. */
  markReceived(event: { id: string; type: string; objectId: string }, at: Date): Promise<boolean>;
  purgeReceived(olderThan: Date): Promise<number>;
}

/** The tenants that have a schema. */
export interface TenantRegistryRepository {
  /** Ids of every tenant with a schema, for the jobs that look at all of them. */
  list(): Promise<string[]>;
  exists(tenantId: string): Promise<boolean>;
  /**
   * Creates the tenant's schema, applies every tenant migration to it and registers the tenant. Idempotent. Only inside
   * a transaction (the lock and the DDL belong to it, so a rollback leaves no schema behind); the TenantCreated use case
   * calls it after `inbox.markProcessed`, in the same transaction.
   */
  provision(tenantId: string, at: Date): Promise<void>;
}

export interface DepositRepository {
  /** Stores a new deposit. False when the user already used this Idempotency-Key (nothing is stored; read the old one). */
  insert(deposit: Deposit): Promise<boolean>;
  /** `forUpdate` locks the row until the end of the transaction (the webhook and the expiry job work on one deposit at a time). */
  get(id: string, options?: { forUpdate?: boolean }): Promise<Deposit | null>;
  findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<Deposit | null>;
  /** Writes the changeable state: status, checkout session, failure reason, job bookkeeping, timestamps. Fails when the row is gone. */
  save(deposit: Deposit): Promise<void>;
  /**
   * Pending deposits whose `nextCheckAt` has come, oldest first, locked for this transaction; a row that another
   * transaction holds is skipped. Inside a transaction that stays open while the provider is called, so a second instance
   * does not look at the same deposit.
   */
  claimDue(now: Date, limit: number): Promise<Deposit[]>;
}

export interface WithdrawalRepository {
  /** Stores a new withdrawal. False when the user already used this Idempotency-Key (nothing is stored; read the old one). */
  insert(withdrawal: Withdrawal): Promise<boolean>;
  get(id: string, options?: { forUpdate?: boolean }): Promise<Withdrawal | null>;
  findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<Withdrawal | null>;
  /** Writes the changeable state. Fails when the row is gone. */
  save(withdrawal: Withdrawal): Promise<void>;
  /** Requested withdrawals whose debit is due, oldest first, locked like `DepositRepository.claimDue`. */
  claimDebitDue(now: Date, limit: number): Promise<Withdrawal[]>;
  /** Debited withdrawals whose payout step is due, oldest first, locked like `DepositRepository.claimDue`. */
  claimPayoutDue(now: Date, limit: number): Promise<Withdrawal[]>;
}

/** The repositories of the shared schema. */
export interface Repositories {
  outbox: OutboxRepository;
  inbox: InboxRepository;
  providerEvents: ProviderEventRepository;
  tenants: TenantRegistryRepository;
}

/** The shared repositories and the deposits and withdrawals of one tenant. */
export interface TenantRepositories extends Repositories {
  deposits: DepositRepository;
  withdrawals: WithdrawalRepository;
}

export interface Store {
  /** Shared repositories outside a transaction: each call is on its own. */
  readonly repositories: Repositories;
  /** Everything the callback does through the given repositories commits together or not at all. */
  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
  /**
   * Like `transaction`, with the schema of one tenant selected for the deposits and withdrawals. Throws `TenantNotReady`
   * when the tenant has no schema yet (its TenantCreated event is not processed). The id is validated; a value that is
   * not a UUID is refused before any statement runs.
   */
  tenantTransaction<T>(tenantId: string, work: (repositories: TenantRepositories) => Promise<T>): Promise<T>;
  /** Cheap check that the store answers (readiness). */
  ping(): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** A UUIDv7. */
  newId(): string;
}

/** Publishes one event to the broker; used by the outbox relay. */
export interface EventPublisher {
  publish(subject: string, event: CloudEvent<unknown>, messageId: string): Promise<void>;
}

/**
 * Handles one consumed event. It resolves when the change and the inbox record are committed (the consumer acknowledges
 * only then); it throws to have the event delivered again, and throws `UnprocessableEvent` for an event that can never
 * be handled.
 */
export type ConsumedEventHandler = (event: ReceivedEvent) => Promise<void>;

export interface Logger {
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
}

// The payment provider (payment-provider/contracts). The adapter sends the currency EUR, the Bearer key, and the id of the
// deposit or withdrawal as Idempotency-Key, so a repeated call after a timeout can never pay twice.

export type CheckoutSessionStatus = "open" | "completed" | "declined" | "expired";
export type PayoutStatus = "pending" | "paid" | "failed";

export interface ProviderCheckoutSession {
  id: string;
  /** The payment page of the buyer. */
  url: string;
  status: CheckoutSessionStatus;
  amount: number;
  /** When the provider lets the open session run out (it turns it to "expired" when it is read after that); null when it did not say. */
  expiresAt: Date | null;
  /** What payments put in when it created the session; the provider returns it unchanged. */
  metadata: Readonly<Record<string, string>>;
}

export interface ProviderPayout {
  id: string;
  status: PayoutStatus;
  amount: number;
  destination: string;
  metadata: Readonly<Record<string, string>>;
  /** "declined" when the provider's test mode declined it; otherwise null. */
  failureReason: string | null;
}

export interface CreateCheckoutSessionInput {
  /** Also the Idempotency-Key. */
  depositId: string;
  tenantId: string;
  amount: number;
  /** The fixed values of the configuration, never taken from a request. */
  successUrl: string;
  cancelUrl: string;
}

export interface CreatePayoutInput {
  /** Also the Idempotency-Key. */
  withdrawalId: string;
  tenantId: string;
  /** The destination of the payout is the user id (opaque, no bank data). */
  userId: string;
  amount: number;
}

/**
 * Failures: `PaymentProviderUnavailable` (not reached, too slow, 429, 5xx, circuit open: try again later),
 * `PaymentProviderRejected` (the provider answered with a 4xx: the call is wrong, trying again does not help) and its
 * subclass `PaymentProviderKeyReused` (409: the Idempotency-Key was used with another body).
 */
export interface PaymentProvider {
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<ProviderCheckoutSession>;
  /** Null when the provider does not know the session (404; it forgets everything when it restarts). */
  getCheckoutSession(id: string): Promise<ProviderCheckoutSession | null>;
  createPayout(input: CreatePayoutInput): Promise<ProviderPayout>;
  /** Null when the provider does not know the payout (404): the payout is lost and counts as failed. */
  getPayout(id: string): Promise<ProviderPayout | null>;
}

// Trading's debit endpoint (contracts/trading-debit.openapi.yaml, a proposal).

export interface DebitRequest {
  withdrawalId: string;
  tenantId: string;
  userId: string;
  amount: number;
  /** Ties trading's log lines and ledger events of the call to ours (`x-correlation-id`); not part of the debit itself. */
  correlationId?: string;
}

/**
 * debited: trading took the credits (also the answer to a repeat of a debit it already made).
 * insufficient: 409, the credits are too few; definitive.
 * circuit_open: nothing was sent, because the circuit to trading was already open.
 * unknown: a request may have reached trading but no definitive answer came (timeout, lost answer, 5xx after the retries,
 * a refused token, an unexpected answer); the debit is repeated with the same withdrawal id until trading answers.
 */
export type DebitOutcome =
  | { kind: "debited" }
  | { kind: "insufficient" }
  | { kind: "circuit_open" }
  | { kind: "unknown"; reason: string };

export interface Trading {
  debit(request: DebitRequest): Promise<DebitOutcome>;
}

/** A client-credentials access token for the calls to trading. */
export interface ServiceTokenSource {
  getToken(signal?: AbortSignal): Promise<string>;
  /** Forgets the cached token (it was rejected). */
  invalidate(): void;
}

/** Runtime keys (ADR-037): read at every use, so a change of the watched file counts without a restart. */
export interface RuntimeSettings {
  forcePayoutFailure(): boolean;
}

/** What the use cases of the requests need. */
export interface UseCaseDeps {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
}

/** The fixed return URLs of the checkout page: values of the configuration, never taken from a request. */
export interface CheckoutUrls {
  successUrl: string;
  cancelUrl: string;
}

/** Everything the money use cases and the background jobs need. */
export interface PaymentsDeps extends UseCaseDeps {
  provider: PaymentProvider;
  trading: Trading;
  settings: RuntimeSettings;
  checkout: CheckoutUrls;
}
