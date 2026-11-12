import { BrokenCircuitError } from "cockatiel";
import type { DebitOutcome, DebitRequest, ServiceTokenSource, Trading } from "../../usecases/ports.js";
import { HttpStatusError, StaleTokenError, createPolicy, describeFailure, isRecord, safeJson, statusErrorOf } from "../http/resilience.js";
import type { ResilienceOptions } from "../http/resilience.js";

export interface TradingClientOptions extends ResilienceOptions {
  /** Base URL of trading, for example http://trading:8081. */
  baseUrl: string;
  tokens: ServiceTokenSource;
}

/**
 * Trading over its debit endpoint (contracts/trading-debit.openapi.yaml, a proposal): POST /v1/internal/debits with the
 * client-credentials token of the client "payments". The debit is idempotent by withdrawal id, so the call may be repeated
 * (the retry inside one call, and the background job later) until trading answers definitively.
 *
 * The outcome, never an exception: debited (200); insufficient (409); circuit_open (the circuit was already open and nothing
 * was sent); unknown (everything else: a timeout, a lost answer, 5xx after the retries, a token or an answer that is not
 * accepted). Only the first two are definitive.
 */
export class TradingClient implements Trading {
  private readonly base: string;
  private readonly http: typeof fetch;
  private readonly policy;

  constructor(private readonly options: TradingClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.http = options.fetch ?? fetch;
    this.policy = createPolicy(options);
  }

  async debit(request: DebitRequest): Promise<DebitOutcome> {
    // True once a request with the debit left this process. An open circuit before that is "nothing was sent".
    let sent = false;
    let refreshed = false;
    try {
      return await this.policy.execute(async ({ signal }): Promise<DebitOutcome> => {
        const token = await this.options.tokens.getToken(signal);
        sent = true;
        const response = await this.http(`${this.base}/v1/internal/debits`, {
          method: "POST",
          // Idempotency-Key: the withdrawal id (plan REL-03); trading checks that it equals the body's withdrawalId.
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
            "idempotency-key": request.withdrawalId,
            ...(request.correlationId ? { "x-correlation-id": request.correlationId } : {}),
          },
          body: JSON.stringify({ withdrawalId: request.withdrawalId, tenantId: request.tenantId, userId: request.userId, amount: request.amount }),
          signal,
        });
        if (response.status === 401 && !refreshed) {
          // The cached token may have been revoked: fetch a new one and repeat once.
          refreshed = true;
          this.options.tokens.invalidate();
          await response.body?.cancel();
          throw new StaleTokenError(401);
        }
        if (response.status === 409) {
          await response.body?.cancel();
          return { kind: "insufficient" };
        }
        if (!response.ok) throw await statusErrorOf(response);
        const body = safeJson(await response.text());
        if (isRecord(body) && body["status"] === "debited") return { kind: "debited" };
        return { kind: "unknown", reason: "trading's answer to the debit is not a debit result" };
      });
    } catch (error) {
      if (error instanceof BrokenCircuitError) {
        return sent ? { kind: "unknown", reason: "the circuit to trading opened during the call" } : { kind: "circuit_open" };
      }
      const status = error instanceof HttpStatusError ? ` (trading answered ${error.status}${error.code ? ` ${error.code}` : ""})` : "";
      return { kind: "unknown", reason: `${describeFailure(error)}${status}`.slice(0, 300) };
    }
  }
}
