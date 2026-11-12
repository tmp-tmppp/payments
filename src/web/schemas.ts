import { AMOUNT_MAX, AMOUNT_MIN, isValidAmount } from "../domain/amount.js";
import { isUuid } from "../domain/consumed-events.js";
import type { Deposit } from "../domain/deposit.js";
import { isStorableText } from "../domain/text.js";
import type { Withdrawal } from "../domain/withdrawal.js";
import { ValidationFailed } from "../usecases/errors.js";
import type { FieldError } from "../usecases/errors.js";
import type { ProviderEventInput } from "../usecases/provider-events.js";
import { IDEMPOTENCY_KEY_PATTERN } from "../usecases/support.js";

// The shapes of the routes. They mirror contracts/openapi.yaml, and tests/contracts compares the routes and their answers with
// that file. Input is checked by hand and not by the JSON schema of the framework, whose type coercion would let the string
// "500" or the value true pass for an integer; the response schemas only shape the output.

const fieldError = {
  type: "object",
  properties: { field: { type: "string" }, message: { type: "string" } },
} as const;

export const problemSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string" },
    errors: { type: "array", items: fieldError },
    // Set when a withdrawal was rejected: the id of the stored withdrawal.
    withdrawalId: { type: "string" },
  },
} as const;

export const errorResponses = { "4xx": problemSchema, "5xx": problemSchema } as const;

const nullableText = { type: ["string", "null"] } as const;

const depositSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    userId: { type: "string" },
    amount: { type: "integer" },
    status: { type: "string" },
    checkoutUrl: nullableText,
    failureReason: nullableText,
    expiresAt: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    completedAt: nullableText,
  },
} as const;

const withdrawalSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    userId: { type: "string" },
    amount: { type: "integer" },
    status: { type: "string" },
    reason: nullableText,
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    completedAt: nullableText,
  },
} as const;

export const schemas = {
  health: {
    response: {
      200: { type: "object", properties: { status: { type: "string" } } },
      ...errorResponses,
    },
  },
  deposit: { response: { 200: depositSchema, 201: depositSchema, ...errorResponses } },
  withdrawal: { response: { 200: withdrawalSchema, 202: withdrawalSchema, ...errorResponses } },
  webhook: { response: { 200: { type: "object", properties: { status: { type: "string" } } }, ...errorResponses } },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function invalid(errors: FieldError[]): never {
  throw new ValidationFailed(errors);
}

/** The body of POST /v1/deposits and POST /v1/withdrawals: exactly `{ "amount": <integer 1..1000000> }`, nothing else. */
export function parseAmountRequest(body: unknown): number {
  if (!isRecord(body)) return invalid([{ field: "body", message: "must be a JSON object" }]);
  const errors: FieldError[] = Object.keys(body)
    .filter((key) => key !== "amount")
    .map((key) => ({ field: key, message: "is not allowed" }));
  if (!("amount" in body)) errors.push({ field: "amount", message: "is required" });
  else if (!isValidAmount(body["amount"])) errors.push({ field: "amount", message: `must be an integer from ${AMOUNT_MIN} to ${AMOUNT_MAX}` });
  if (errors.length > 0) invalid(errors);
  return body["amount"] as number;
}

/** The Idempotency-Key header: required, 1 to 255 characters of A-Z a-z 0-9 . _ : - */
export function parseIdempotencyKey(header: string | string[] | undefined): string {
  if (header === undefined) return invalid([{ field: "Idempotency-Key", message: "is required" }]);
  if (typeof header !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    return invalid([{ field: "Idempotency-Key", message: "must be 1 to 255 characters of A-Z a-z 0-9 . _ : -" }]);
  }
  return header;
}

/** The `id` of a path: a UUID. */
export function parseResourceId(value: unknown): string {
  if (!isUuid(value)) return invalid([{ field: "id", message: "must be a UUID" }]);
  return value.toLowerCase();
}

const OBJECT_KINDS = { checkout_session: "checkout_session", payout: "payout" } as const;

/** The thin body of the provider's webhook, after its signature was verified: the event id and type, and the object it is about. */
export function parseProviderEvent(rawBody: Buffer): Omit<ProviderEventInput, "correlationId"> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return invalid([{ field: "body", message: "is not valid JSON" }]);
  }
  if (!isRecord(body)) return invalid([{ field: "body", message: "must be a JSON object" }]);
  const errors: FieldError[] = [];
  // A NUL or a lone surrogate would fail or change in PostgreSQL, so such text is refused like any other bad field.
  const text = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 255 && isStorableText(value);
  const data = isRecord(body["data"]) ? body["data"] : {};
  if (!text(body["id"])) errors.push({ field: "id", message: "must be text of 1 to 255 characters" });
  if (!text(body["type"])) errors.push({ field: "type", message: "must be text of 1 to 255 characters" });
  const kind = typeof data["object"] === "string" ? (OBJECT_KINDS as Record<string, "checkout_session" | "payout" | undefined>)[data["object"]] : undefined;
  if (kind === undefined) errors.push({ field: "data.object", message: "must be checkout_session or payout" });
  if (!text(data["id"])) errors.push({ field: "data.id", message: "must be text of 1 to 255 characters" });
  if (errors.length > 0 || kind === undefined) return invalid(errors);
  return { id: body["id"] as string, type: body["type"] as string, objectKind: kind, objectId: data["id"] as string };
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** The deposit as the contract shows it: no tenant, no key, no hash, no provider internals. */
export function depositBody(deposit: Deposit) {
  return {
    id: deposit.id,
    userId: deposit.userId,
    amount: deposit.amount,
    status: deposit.status,
    checkoutUrl: deposit.checkoutUrl,
    failureReason: deposit.failureReason,
    expiresAt: deposit.expiresAt.toISOString(),
    createdAt: deposit.createdAt.toISOString(),
    updatedAt: deposit.updatedAt.toISOString(),
    completedAt: iso(deposit.completedAt),
  };
}

export function withdrawalBody(withdrawal: Withdrawal) {
  return {
    id: withdrawal.id,
    userId: withdrawal.userId,
    amount: withdrawal.amount,
    status: withdrawal.status,
    reason: withdrawal.reason,
    createdAt: withdrawal.createdAt.toISOString(),
    updatedAt: withdrawal.updatedAt.toISOString(),
    completedAt: iso(withdrawal.completedAt),
  };
}
