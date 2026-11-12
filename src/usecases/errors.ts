import { DomainError } from "../domain/errors.js";

// Transport-agnostic errors of the use cases. Only src/web maps them to HTTP status codes (GP-6.28).
export type UseCaseErrorKind = "validation" | "not_found" | "conflict" | "unavailable";

export interface FieldError {
  field: string;
  message: string;
}

export class UseCaseError extends Error {
  constructor(
    readonly kind: UseCaseErrorKind,
    /** Stable machine-readable code, for example "idempotency_key_reused". */
    readonly code: string,
    message: string,
    readonly fields: readonly FieldError[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationFailed extends UseCaseError {
  constructor(fields: readonly FieldError[], message = "The request is invalid") {
    super("validation", "validation_failed", message, fields);
  }
}

export class NotFound extends UseCaseError {
  constructor(code: string, message: string) {
    super("not_found", code, message);
  }
}

export class Conflict extends UseCaseError {
  constructor(code: string, message: string) {
    super("conflict", code, message);
  }
}

/**
 * Something this request needs is not there right now: the tenant's schema does not exist yet (TenantCreated is not
 * processed), the payment provider or trading is down and its circuit is open. The caller tries again after
 * `retryAfterSeconds` (HTTP 503 with Retry-After at the edge).
 */
export class Unavailable extends UseCaseError {
  constructor(
    code: string,
    message: string,
    readonly retryAfterSeconds: number,
    options?: ErrorOptions,
  ) {
    super("unavailable", code, message, [], options);
  }
}

/** Seconds a client waits before it asks again for a tenant whose schema is not there yet. */
export const TENANT_NOT_READY_RETRY_SECONDS = 5;

/** The tenant has no schema yet: its TenantCreated event has not been processed. The web layer answers 503 with Retry-After. */
export class TenantNotReady extends Unavailable {
  constructor(readonly tenantId: string) {
    super("tenant_not_ready", "The tenant is not ready yet, try again shortly", TENANT_NOT_READY_RETRY_SECONDS);
  }
}

/**
 * A withdrawal was rejected because trading answered 409: the user has too few credits. The withdrawal is stored (state
 * `rejected`), so the 409 answer names it and links to it.
 */
export class InsufficientCredits extends Conflict {
  constructor(readonly withdrawalId: string) {
    super("insufficient_credits", "The user has too few credits for this withdrawal");
  }
}

/** Seconds a client waits before it asks again after the circuit to trading was found open. */
export const TRADING_RETRY_AFTER_SECONDS = 10;

/** A withdrawal was rejected because the circuit to trading was already open before any call was sent: nothing was debited. */
export class TradingUnavailable extends Unavailable {
  constructor(readonly withdrawalId: string) {
    super("trading_unavailable", "Trading cannot be reached right now; nothing was debited, try again shortly", TRADING_RETRY_AFTER_SECONDS);
  }
}

/** A consumed event that can never be handled (it is no valid event, or says something impossible): the consumer drops it. */
export class UnprocessableEvent extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnprocessableEvent";
  }
}

/** The payment provider cannot be used now: not reached, too slow, overloaded (429, 5xx) or its circuit is open. Try again later. */
export class PaymentProviderUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentProviderUnavailable";
  }
}

/** The provider answered with a 4xx. The call itself is wrong (or the key is), so repeating it does not help. */
export class PaymentProviderRejected extends Error {
  constructor(
    readonly status: number,
    /** The provider's `code` of the problem, when it sent one. */
    readonly code: string | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 409 idempotency_key_reused: the Idempotency-Key was used before with another body. */
export class PaymentProviderKeyReused extends PaymentProviderRejected {
  constructor(message: string, options?: ErrorOptions) {
    super(409, "idempotency_key_reused", message, options);
  }
}

/** Turns a rule violation of the domain into the use-case error a caller can act on. */
export function fromDomainError(error: DomainError): UseCaseError {
  switch (error.code) {
    case "invalid_amount":
      return new ValidationFailed([{ field: error.field ?? "amount", message: error.message }]);
    case "illegal_transition":
      return new Conflict("illegal_transition", error.message);
  }
}

/** Runs domain code and reports its rule violations as use-case errors. */
export function guardDomain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DomainError) throw fromDomainError(error);
    throw error;
  }
}
