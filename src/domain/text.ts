// Text from outside (a webhook body, another service's event) that payments stores in PostgreSQL.

// In unicode mode \p{Surrogate} matches a surrogate that is not half of a valid pair, and nothing else.
const LONE_SURROGATE = /\p{Surrogate}/u;
const LONE_SURROGATES = /\p{Surrogate}/gu;

/** The longest `last_error` text a deposit or withdrawal keeps. */
export const LAST_ERROR_MAX_LENGTH = 500;

/**
 * True for a text that PostgreSQL stores and returns exactly as it is: no NUL character (text and jsonb refuse it, so the
 * insert would fail on every redelivery) and no lone UTF-16 surrogate (valid in a JavaScript string and in the JSON escape
 * "\ud800", but the driver writes UTF-8, which turns it into U+FFFD, and jsonb rejects the escape).
 */
export function isStorableText(value: string): boolean {
  return !value.includes("\u0000") && !LONE_SURROGATE.test(value);
}

/**
 * A text payments wrote itself from something outside (an upstream error's detail, an exception message), made storable:
 * cut to maxLength UTF-16 units first, then each NUL and each lone surrogate (also half a pair the cut split) becomes U+FFFD.
 */
export function toStorableText(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(LONE_SURROGATES, "�").replaceAll("\u0000", "�");
}
