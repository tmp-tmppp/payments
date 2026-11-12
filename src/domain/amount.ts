import { DomainError } from "./errors.js";

// One unit everywhere: 1 credit = 1 EUR cent. Every amount (API, database, events, the debit call and the provider call)
// is one positive integer named "amount"; there is no conversion. The bounds are the provider's own (1 to 1 000 000).
export const AMOUNT_MIN = 1;
export const AMOUNT_MAX = 1_000_000;
/** The currency of every provider call. */
export const CURRENCY = "EUR";

export function isValidAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= AMOUNT_MIN && value <= AMOUNT_MAX;
}

/** Returns the amount or throws a DomainError that names the field. A string, a fraction, 0 and a negative are all refused. */
export function parseAmount(value: unknown, field = "amount"): number {
  if (!isValidAmount(value)) {
    throw new DomainError("invalid_amount", `${field} must be an integer from ${AMOUNT_MIN} to ${AMOUNT_MAX}`, field);
  }
  return value;
}
