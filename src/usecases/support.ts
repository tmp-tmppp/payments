import { createHash } from "node:crypto";
import { natsSubject } from "../domain/events.js";
import type { CloudEvent, EventContext, EventName } from "../domain/events.js";
import { PaymentProviderRejected, PaymentProviderUnavailable, Unavailable, ValidationFailed } from "./errors.js";
import type { Caller, IdGenerator, Logger, OutboxMessage } from "./ports.js";

/** A user id (the subject of the identity provider): 1 to 255 characters. */
export const USER_ID_MAX_LENGTH = 255;

/** The caller of a money use case: the tenant and the user come from the verified token, nothing else. */
export interface TenantCaller extends Caller {
  tenantId: string;
}

/** 1 to 255 characters of A-Z a-z 0-9 . _ : - (the same alphabet as the provider's). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;

export function checkIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ValidationFailed([{ field: "Idempotency-Key", message: "must be 1 to 255 characters of A-Z a-z 0-9 . _ : -" }]);
  }
}

/** Digest of what a request asked for: the same key with another digest is a conflict. */
export function requestHash(body: { amount: number }): string {
  return createHash("sha256").update(JSON.stringify({ amount: body.amount })).digest("hex");
}

/** Waits that double with every attempt, up to a ceiling: 2 s, 4 s, 8 s ... */
export function backoffMs(attempts: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempts, 20));
}

export const addMs = (date: Date, ms: number): Date => new Date(date.getTime() + ms);

export function eventContext(deps: { ids: IdGenerator }, caller: Caller, now: Date): EventContext {
  return { eventId: deps.ids.newId(), now, correlationId: caller.correlationId, causationId: caller.causationId };
}

/** The outbox row of an event, in the transaction that changes the data (REL-01). */
export function outboxMessage(
  name: EventName,
  event: CloudEvent<unknown>,
  aggregateId: string,
  now: Date,
): OutboxMessage {
  return {
    id: event.id,
    aggregateId,
    subject: natsSubject(name, event.tenantid),
    type: event.type,
    payload: event,
    createdAt: now,
  };
}

/**
 * A failure of the payment provider as the use-case error a caller can act on: 503 with Retry-After. A 4xx of the provider
 * is our own mistake (a wrong key, a wrong call), so it is logged as an error and waits longer; anything else is thrown on.
 */
export function providerFailure(error: unknown, logger: Logger, what: string): Unavailable | null {
  if (error instanceof PaymentProviderUnavailable) {
    logger.warn({ err: error }, `The payment provider could not be reached: ${what}`);
    return new Unavailable("provider_unavailable", "The payment provider cannot be reached right now, try again shortly", 10, { cause: error });
  }
  if (error instanceof PaymentProviderRejected) {
    logger.error({ err: error, status: error.status, providerCode: error.code }, `The payment provider refused the call: ${what}`);
    return new Unavailable("provider_unavailable", "The payment provider cannot take this request right now, try again later", 60, { cause: error });
  }
  return null;
}
