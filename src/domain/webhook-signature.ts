import { createHmac, timingSafeEqual } from "node:crypto";

// Verification of the payment provider's webhook signature (payment-provider/contracts/README.md, "The signature").
// Header: "Provider-Signature: t=<unix seconds>,v1=<hex>". v1 is the lower-case hex of
// HMAC-SHA256(key = webhook secret, message = "<t>." followed by the raw body, byte for byte). The header may carry
// several v1 (a rotated secret is signed twice); the event is accepted when any of them matches. A timestamp more than
// 300 seconds from now is refused, so that an old capture cannot be replayed later. This is the only proof of origin
// the public webhook route has: it runs on the raw body, before the body is parsed.

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type SignatureFailure = "missing_header" | "malformed_header" | "stale_timestamp" | "no_matching_signature";

export type SignatureCheck = { valid: true } | { valid: false; reason: SignatureFailure };

export interface SignatureInput {
  secret: string;
  /** The value of the Provider-Signature header, or undefined when the request had none. */
  header: string | undefined;
  /** The request body exactly as received: the bytes, never a parsed and serialized copy. */
  rawBody: Buffer | string;
  /** The current time in whole seconds since 1970 (UTC). */
  nowSeconds: number;
  toleranceSeconds?: number;
}

interface ParsedHeader {
  timestamp: string;
  signatures: Buffer[];
}

const TIMESTAMP_PATTERN = /^\d{1,12}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

/** Splits the header into `t` and the `v1` values. Null when `t` is missing, repeated or not digits, or when there is no `v1`. */
export function parseSignatureHeader(header: string): ParsedHeader | null {
  let timestamp: string | null = null;
  let sawSignature = false;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      if (timestamp !== null || !TIMESTAMP_PATTERN.test(value)) return null;
      timestamp = value;
    } else if (key === "v1") {
      sawSignature = true;
      // A value that is not 64 lower-case hex digits cannot match; it is skipped, the others may still match.
      if (SIGNATURE_PATTERN.test(value)) signatures.push(Buffer.from(value, "hex"));
    }
    // Other keys (a later scheme, v0) are ignored.
  }
  if (timestamp === null || !sawSignature) return null;
  return { timestamp, signatures };
}

/** The expected `v1` of a body, as raw bytes. */
export function signWebhook(secret: string, timestamp: string, rawBody: Buffer | string): Buffer {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
}

export function verifyWebhookSignature(input: SignatureInput): SignatureCheck {
  if (input.header === undefined || input.header.trim() === "") return { valid: false, reason: "missing_header" };
  const parsed = parseSignatureHeader(input.header);
  if (parsed === null) return { valid: false, reason: "malformed_header" };
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - Number(parsed.timestamp)) > tolerance) return { valid: false, reason: "stale_timestamp" };
  const expected = signWebhook(input.secret, parsed.timestamp, input.rawBody);
  // Every candidate is compared (no early exit on the first hit), each in constant time.
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) matched = true;
  }
  return matched ? { valid: true } : { valid: false, reason: "no_matching_signature" };
}
