import {
  BrokenCircuitError,
  ConsecutiveBreaker,
  ExponentialBackoff,
  TaskCancelledError,
  TimeoutStrategy,
  circuitBreaker,
  handleWhen,
  retry,
  timeout,
  wrap,
} from "cockatiel";
import type { IBackoff, IBackoffFactory, IRetryBackoffContext } from "cockatiel";

// The resilience every outgoing HTTP call has (REL-04): a timeout per attempt, a retry with exponential backoff and jitter
// (network errors, timeouts, 429 and 5xx only) and one circuit breaker shared by all calls of a client. The payment
// provider, trading and the token endpoint each get their own policy, so one that is down does not open another's circuit.

export interface ResilienceOptions {
  /** Per attempt. Default 3000. */
  timeoutMs?: number;
  /** Attempts per call, the first one included. Default 3. */
  maxAttempts?: number;
  /** First and largest wait between attempts (exponential backoff with jitter). Defaults 250 and 2000. */
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Consecutive failures that open the circuit, and the wait before one trial call. Defaults 5 and 10000. */
  breakerThreshold?: number;
  halfOpenAfterMs?: number;
  fetch?: typeof fetch;
}

/** The server answered with a status the caller did not accept. `code` is the `code` of its problem+json body, when it sent one. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null = null,
    detail?: string,
  ) {
    super(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

/** The cached access token was rejected: a new one is fetched and the call is repeated. */
export class StaleTokenError extends HttpStatusError {}

/**
 * A failed call of a transport that is not HTTP (the gRPC debit): it says itself whether the same call may succeed a
 * moment later, and how long the server asked to wait before the next attempt (`waitMs`, null: the own backoff).
 */
export class CallFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly waitMs: number | null = null,
  ) {
    super(message);
    this.name = "CallFailure";
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Worth another attempt right now: the same call may succeed a moment later. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof StaleTokenError) return true;
  if (error instanceof CallFailure) return error.retryable;
  if (error instanceof HttpStatusError) return error.status === 429 || error.status >= 500;
  if (error instanceof TaskCancelledError) return true;
  // fetch rejects with a TypeError when the network fails and with an AbortError when it is aborted.
  return error instanceof TypeError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

/** The server cannot be used at the moment, whatever the call: not reached, too slow, overloaded, cut off, or its circuit is open. */
export function isUnavailable(error: unknown): boolean {
  return isRetryable(error) || error instanceof BrokenCircuitError;
}

type RetryContext = IRetryBackoffContext<unknown>;

/** The wait before the next attempt: the server's own (a CallFailure with waitMs, from retry-after), else the inner backoff's. */
function serverWaitOr(own: IBackoff<RetryContext>, context: RetryContext): IBackoff<RetryContext> {
  const error = "error" in context.result ? context.result.error : undefined;
  const asked = error instanceof CallFailure ? error.waitMs : null;
  return { duration: asked ?? own.duration, next: (later) => serverWaitOr(own.next(later), later) };
}

/** A backoff that honours the wait a server asked for; with no such wait it is the inner backoff unchanged. */
export function honouringServerWait(inner: IBackoffFactory<RetryContext>): IBackoffFactory<RetryContext> {
  return { next: (context) => serverWaitOr(inner.next(context), context) };
}

export function createPolicy(options: ResilienceOptions) {
  const maxAttempts = options.maxAttempts ?? 3;
  // Outermost first: retry, then the circuit breaker, then the timeout of one attempt.
  return wrap(
    retry(handleWhen(isRetryable), {
      maxAttempts: Math.max(0, maxAttempts - 1),
      backoff: honouringServerWait(new ExponentialBackoff({ initialDelay: options.retryInitialDelayMs ?? 250, maxDelay: options.retryMaxDelayMs ?? 2000 })),
    }),
    circuitBreaker(handleWhen(isRetryable), {
      halfOpenAfter: options.halfOpenAfterMs ?? 10_000,
      breaker: new ConsecutiveBreaker(options.breakerThreshold ?? 5),
    }),
    timeout(options.timeoutMs ?? 3000, TimeoutStrategy.Aggressive),
  );
}

export type ResiliencePolicy = ReturnType<typeof createPolicy>;

/** The error for a response that is not a success: its status and the `code` of an RFC 9457 body. The body is read and dropped. */
export async function statusErrorOf(response: Response): Promise<HttpStatusError> {
  let code: string | null = null;
  let detail: string | undefined;
  try {
    const body = safeJson((await response.text()).slice(0, 8192));
    if (isRecord(body)) {
      if (typeof body["code"] === "string") code = body["code"];
      if (typeof body["detail"] === "string") detail = body["detail"].slice(0, 200);
    }
  } catch {
    // An unreadable body only leaves the status.
  }
  return new HttpStatusError(response.status, code, detail);
}

/** A short, secret-free description of a failure for a log line or a `last_error` column. */
export function describeFailure(error: unknown): string {
  if (error instanceof BrokenCircuitError) return "circuit open";
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}
