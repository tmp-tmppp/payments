import { BrokenCircuitError } from "cockatiel";
import { CURRENCY } from "../../domain/amount.js";
import { isStorableText } from "../../domain/text.js";
import {
  PaymentProviderKeyReused,
  PaymentProviderRejected,
  PaymentProviderUnavailable,
} from "../../usecases/errors.js";
import type {
  CheckoutSessionStatus,
  CreateCheckoutSessionInput,
  CreatePayoutInput,
  PaymentProvider,
  PayoutStatus,
  ProviderCheckoutSession,
  ProviderPayout,
} from "../../usecases/ports.js";
import { HttpStatusError, createPolicy, describeFailure, isRecord, isUnavailable, safeJson, statusErrorOf } from "../http/resilience.js";
import type { ResilienceOptions } from "../http/resilience.js";

export interface PaymentProviderClientOptions extends ResilienceOptions {
  /** Base URL of the provider, for example http://payment-provider:8080. */
  baseUrl: string;
  /** The Bearer API key of the one merchant (a Secret). It is only ever sent as the Authorization header. */
  apiKey: string;
}

const SESSION_STATUSES: readonly CheckoutSessionStatus[] = ["open", "completed", "declined", "expired"];
const PAYOUT_STATUSES: readonly PayoutStatus[] = ["pending", "paid", "failed"];

const notThe = (what: string): PaymentProviderUnavailable => new PaymentProviderUnavailable(`The provider's answer is not ${what}`);

function metadataOf(value: unknown): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") metadata[key] = entry;
  }
  return metadata;
}

function parseSession(json: unknown): ProviderCheckoutSession {
  if (!isRecord(json)) throw notThe("a checkout session");
  const { id, url, status, amount } = json;
  if (typeof id !== "string" || typeof url !== "string" || typeof amount !== "number") throw notThe("a checkout session");
  // The id and the URL are stored with the deposit: text PostgreSQL cannot keep as it is would fail every save.
  if (!isStorableText(id) || !isStorableText(url)) throw notThe("a checkout session");
  if (typeof status !== "string" || !SESSION_STATUSES.includes(status as CheckoutSessionStatus)) throw notThe("a checkout session");
  const expires = typeof json["expiresAt"] === "string" ? new Date(json["expiresAt"]) : null;
  return {
    id,
    url,
    status: status as CheckoutSessionStatus,
    amount,
    expiresAt: expires !== null && !Number.isNaN(expires.getTime()) ? expires : null,
    metadata: metadataOf(json["metadata"]),
  };
}

function parsePayout(json: unknown): ProviderPayout {
  if (!isRecord(json)) throw notThe("a payout");
  const { id, status, amount, destination, failureReason } = json;
  if (typeof id !== "string" || typeof amount !== "number" || typeof destination !== "string") throw notThe("a payout");
  if (!isStorableText(id) || !isStorableText(destination)) throw notThe("a payout");
  if (typeof status !== "string" || !PAYOUT_STATUSES.includes(status as PayoutStatus)) throw notThe("a payout");
  return {
    id,
    status: status as PayoutStatus,
    amount,
    destination,
    metadata: metadataOf(json["metadata"]),
    failureReason: typeof failureReason === "string" ? failureReason : null,
  };
}

interface Call {
  idempotencyKey?: string;
  body?: unknown;
  /** A 404 is an answer ("the provider does not know it"), not a failure. */
  notFoundIsNull?: boolean;
}

/**
 * PaymentProvider over the provider's REST API (payment-provider/contracts/README.md). Every call has a timeout, a retry
 * with backoff and jitter (network errors, timeouts, 429, 5xx) and one circuit breaker shared by all calls. A failure that
 * is left after the retries is named by what it means: `PaymentProviderUnavailable` (try again later),
 * `PaymentProviderKeyReused` (409 idempotency_key_reused) or `PaymentProviderRejected` (any other 4xx).
 * The Idempotency-Key of a create call is the id of the deposit or withdrawal, so a retry cannot pay twice.
 */
export class PaymentProviderClient implements PaymentProvider {
  private readonly base: string;
  private readonly http: typeof fetch;
  private readonly policy;

  constructor(private readonly options: PaymentProviderClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.http = options.fetch ?? fetch;
    this.policy = createPolicy(options);
  }

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<ProviderCheckoutSession> {
    const reply = await this.call("POST", "/v1/checkout-sessions", {
      idempotencyKey: input.depositId,
      body: {
        amount: input.amount,
        currency: CURRENCY,
        metadata: { tenantId: input.tenantId, depositId: input.depositId },
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      },
    });
    return parseSession(reply);
  }

  async getCheckoutSession(id: string): Promise<ProviderCheckoutSession | null> {
    const reply = await this.call("GET", `/v1/checkout-sessions/${encodeURIComponent(id)}`, { notFoundIsNull: true });
    return reply === null ? null : parseSession(reply);
  }

  async createPayout(input: CreatePayoutInput): Promise<ProviderPayout> {
    const reply = await this.call("POST", "/v1/payouts", {
      idempotencyKey: input.withdrawalId,
      body: {
        amount: input.amount,
        currency: CURRENCY,
        destination: input.userId,
        metadata: { tenantId: input.tenantId, withdrawalId: input.withdrawalId },
      },
    });
    return parsePayout(reply);
  }

  async getPayout(id: string): Promise<ProviderPayout | null> {
    const reply = await this.call("GET", `/v1/payouts/${encodeURIComponent(id)}`, { notFoundIsNull: true });
    return reply === null ? null : parsePayout(reply);
  }

  /** One call under the resilience policy; the parsed JSON body, or null for an accepted 404. */
  private async call(method: string, path: string, call: Call): Promise<unknown> {
    try {
      return await this.policy.execute(async ({ signal }) => {
        const response = await this.http(`${this.base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            accept: "application/json",
            ...(call.body === undefined ? {} : { "content-type": "application/json" }),
            ...(call.idempotencyKey === undefined ? {} : { "idempotency-key": call.idempotencyKey }),
          },
          ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
          signal,
        });
        if (response.status === 404 && call.notFoundIsNull) {
          await response.body?.cancel();
          return null;
        }
        if (!response.ok) throw await statusErrorOf(response);
        return safeJson(await response.text());
      });
    } catch (error) {
      throw this.named(error, `${method} ${path.replace(/\/[^/]+$/, (last) => (/^\/(cs|po)_/.test(last) ? "/{id}" : last))}`);
    }
  }

  /** Names a failure that is left after the retries (see the class comment). The operation text carries no ids or secrets. */
  private named(error: unknown, operation: string): Error {
    if (error instanceof PaymentProviderUnavailable || error instanceof PaymentProviderRejected) return error;
    if (error instanceof HttpStatusError && !isUnavailable(error)) {
      const message = `The payment provider rejected ${operation} (${error.message})`;
      return error.status === 409 && error.code === "idempotency_key_reused"
        ? new PaymentProviderKeyReused(message, { cause: error })
        : new PaymentProviderRejected(error.status, error.code, message, { cause: error });
    }
    if (isUnavailable(error) || error instanceof BrokenCircuitError) {
      return new PaymentProviderUnavailable(`The payment provider is unavailable in ${operation} (${describeFailure(error)})`, { cause: error });
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
