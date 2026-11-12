import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { BrokenCircuitError, TaskCancelledError } from "cockatiel";
import { toStorableText } from "../../domain/text.js";
import type { DebitOutcome, DebitRequest, ServiceTokenSource, Trading } from "../../usecases/ports.js";
import { CallFailure, createPolicy, describeFailure } from "../http/resilience.js";
import type { ResilienceOptions } from "../http/resilience.js";

/**
 * trading's contract (contracts/external/trading-debit.proto, a plain copy of trading's file), found from the compiled
 * module (dist/adapters/trading) as from the source (src/adapters/trading): the service's root is three levels up in both.
 * The Dockerfile copies the file to the same place in the image.
 */
export const TRADING_DEBIT_PROTO_FILE = fileURLToPath(new URL("../../../contracts/external/trading-debit.proto", import.meta.url));

/** Field names as the proto writes them (`withdrawal_id`), the status as its name, absent fields as their defaults. */
export const PROTO_LOADER_OPTIONS: protoLoader.Options = { keepCase: true, enums: String, defaults: true };

/** The longest `retry-after` of trading that one call waits for; a longer one ends the call, and the job repeats the debit later. */
export const RETRY_AFTER_MAX_MS = 5000;

/**
 * Statuses worth another attempt right away: no answer, a lost or cut answer, or trading busy for a moment. The same set
 * as 5xx and network failures of the REST client. Every other status is not definitive either, but repeating it at once
 * would get the same answer (ALREADY_EXISTS, INVALID_ARGUMENT, PERMISSION_DENIED, RESOURCE_EXHAUSTED, ...).
 */
const RETRYABLE = new Set<grpc.status>([
  grpc.status.UNAVAILABLE,
  grpc.status.DEADLINE_EXCEEDED,
  grpc.status.CANCELLED,
  grpc.status.INTERNAL,
  grpc.status.UNKNOWN,
  grpc.status.ABORTED,
]);

/**
 * The HTTP/2 ping of an open connection, sent at the start of a call once this long has passed since the last one
 * (never while no call runs, so an idle channel sends nothing), and the wait for its answer. Without it a trading Pod
 * that vanished without closing its connections (a lost node, a network split) is not noticed: a deadline or a cancel
 * leaves the connection open, and every debit would time out on it until the kernel gives the TCP connection up, many
 * minutes later. With it the dead connection is dropped and the next attempt connects again through the Service.
 */
export const KEEPALIVE_TIME_MS = 20_000;
export const KEEPALIVE_TIMEOUT_MS = 5_000;

/**
 * The library reconnects with a growing wait; its default ceiling (120 s) would leave debits failing for up to two minutes
 * after trading is back. 10 s matches the circuit breaker's half-open wait.
 */
function channelOptions(keepaliveTimeMs: number, keepaliveTimeoutMs: number): grpc.ChannelOptions {
  return {
    "grpc.initial_reconnect_backoff_ms": 1000,
    "grpc.max_reconnect_backoff_ms": 10_000,
    "grpc.keepalive_time_ms": keepaliveTimeMs,
    "grpc.keepalive_timeout_ms": keepaliveTimeoutMs,
  };
}

export interface TradingGrpcClientOptions extends Omit<ResilienceOptions, "fetch"> {
  /** host:port of trading's gRPC port, for example trading:8082. Plain HTTP/2, as the contract says. */
  address: string;
  tokens: ServiceTokenSource;
  /** Default RETRY_AFTER_MAX_MS. */
  retryAfterMaxMs?: number;
  /** Defaults KEEPALIVE_TIME_MS and KEEPALIVE_TIMEOUT_MS. */
  keepaliveTimeMs?: number;
  keepaliveTimeoutMs?: number;
  /** Default TRADING_DEBIT_PROTO_FILE. */
  protoFile?: string;
}

/** `DebitReply` of the proto as proto-loader gives it (keepCase, enums as names, defaults filled in). */
interface DebitReplyMessage {
  withdrawal_id?: unknown;
  status?: unknown;
  amount?: unknown;
}

type UnaryCallback = (error: grpc.ServiceError | null, reply?: DebitReplyMessage) => void;

interface DebitsStub extends grpc.Client {
  DebitCredits(request: Record<string, unknown>, metadata: grpc.Metadata, options: grpc.CallOptions, callback: UnaryCallback): grpc.ClientUnaryCall;
}

/** The client class `chance.trading.v1.Debits` of the proto file. Throws when the file does not define it. */
export function loadDebitsClient(file: string = TRADING_DEBIT_PROTO_FILE): grpc.ServiceClientConstructor {
  const loaded = grpc.loadPackageDefinition(protoLoader.loadSync(file, PROTO_LOADER_OPTIONS));
  const service = ["chance", "trading", "v1", "Debits"].reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], loaded);
  if (typeof service !== "function" || !("DebitCredits" in (service as grpc.ServiceClientConstructor).service)) {
    throw new Error(`${file} does not define the service chance.trading.v1.Debits with the call DebitCredits`);
  }
  return service as grpc.ServiceClientConstructor;
}

function isServiceError(error: unknown): error is grpc.ServiceError {
  return error instanceof Error && typeof (error as Partial<grpc.ServiceError>).code === "number" && (error as Partial<grpc.ServiceError>).metadata instanceof grpc.Metadata;
}

/** The first value of a text metadata key, or undefined. */
function textOf(metadata: grpc.Metadata, key: string): string | undefined {
  const [value] = metadata.get(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Trading over its gRPC debit (REQ-17; contracts/external/trading-debit.proto): `chance.trading.v1.Debits/DebitCredits`
 * with the client-credentials token of the client "payments" in the metadata `authorization`, the caller's
 * `x-correlation-id`, and a deadline on every attempt. The same port, outcomes and resilience as the REST client
 * (TradingClient): the debit is idempotent by withdrawal id, so it may be repeated until trading answers definitively.
 *
 * The outcome, never an exception: debited (OK with DEBIT_STATUS_DEBITED for this withdrawal and amount); insufficient
 * (FAILED_PRECONDITION with `chance-problem-code: insufficient_credits`); circuit_open (nothing was sent); unknown
 * (everything else). Only the first two are definitive.
 */
export class TradingGrpcClient implements Trading {
  private readonly client: DebitsStub;
  private readonly policy;
  private readonly timeoutMs: number;
  private readonly retryAfterMaxMs: number;

  constructor(private readonly options: TradingGrpcClientOptions) {
    const Debits = loadDebitsClient(options.protoFile);
    const channel = channelOptions(options.keepaliveTimeMs ?? KEEPALIVE_TIME_MS, options.keepaliveTimeoutMs ?? KEEPALIVE_TIMEOUT_MS);
    this.client = new Debits(options.address, grpc.credentials.createInsecure(), channel) as unknown as DebitsStub;
    this.policy = createPolicy(options);
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.retryAfterMaxMs = options.retryAfterMaxMs ?? RETRY_AFTER_MAX_MS;
  }

  async debit(request: DebitRequest): Promise<DebitOutcome> {
    // True once a call with the debit left this process. An open circuit before that is "nothing was sent".
    let sent = false;
    let refreshed = false;
    const message = { withdrawal_id: request.withdrawalId, tenant_id: request.tenantId, user_id: request.userId, amount: request.amount };
    try {
      return await this.policy.execute(async ({ signal }): Promise<DebitOutcome> => {
        const token = await this.options.tokens.getToken(signal);
        // The policy may have given this attempt up while the token was on its way (its timeout, then perhaps an open
        // circuit and a decided outcome): an attempt given up never sends the debit.
        if (signal.aborted) throw new TaskCancelledError("the attempt was given up before the debit was sent");
        const metadata = new grpc.Metadata();
        metadata.set("authorization", `Bearer ${token}`);
        if (request.correlationId) metadata.set("x-correlation-id", request.correlationId);
        sent = true;
        let reply: DebitReplyMessage;
        try {
          reply = await this.call(message, metadata, signal);
        } catch (error) {
          if (!isServiceError(error)) throw error;
          if (error.code === grpc.status.UNAUTHENTICATED && !refreshed) {
            // The cached token may have been revoked: fetch a new one and repeat once.
            refreshed = true;
            this.options.tokens.invalidate();
            throw new CallFailure("trading answered UNAUTHENTICATED; repeating once with a new token", true);
          }
          const problem = textOf(error.metadata, "chance-problem-code");
          // Only trading's own refusal is definitive: a FAILED_PRECONDITION without this code is not "too few credits".
          if (error.code === grpc.status.FAILED_PRECONDITION && problem === "insufficient_credits") return { kind: "insufficient" };
          throw this.failureOf(error, problem);
        }
        const sameDebit =
          reply.status === "DEBIT_STATUS_DEBITED" &&
          typeof reply.withdrawal_id === "string" &&
          reply.withdrawal_id.toLowerCase() === request.withdrawalId.toLowerCase() &&
          reply.amount === request.amount;
        if (sameDebit) return { kind: "debited" };
        return { kind: "unknown", reason: "trading's answer to the debit is not a debit result of this withdrawal and amount" };
      });
    } catch (error) {
      if (error instanceof BrokenCircuitError) {
        return sent ? { kind: "unknown", reason: "the circuit to trading opened during the call" } : { kind: "circuit_open" };
      }
      return { kind: "unknown", reason: toStorableText(describeFailure(error), 300) };
    }
  }

  /** Closes the channel (on shutdown). A debit after this is unknown; the job repeats it after the next start. */
  close(): void {
    this.client.close();
  }

  /** One attempt: a unary call with a deadline of the attempt's timeout, cancelled when the policy gives the attempt up. */
  private call(message: Record<string, unknown>, metadata: grpc.Metadata, signal: AbortSignal): Promise<DebitReplyMessage> {
    return new Promise<DebitReplyMessage>((resolve, reject) => {
      let call: grpc.ClientUnaryCall | undefined;
      const onAbort = (): void => call?.cancel();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        call = this.client.DebitCredits(message, metadata, { deadline: new Date(Date.now() + this.timeoutMs) }, (error, reply) => {
          signal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(reply ?? {});
        });
      } catch (error) {
        // A closed channel refuses a new call at once.
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** The error of a status that is not definitive; `retry-after` counts only on an answer of trading itself (with a code). */
  private failureOf(error: grpc.ServiceError, problem: string | undefined): CallFailure {
    const name = grpc.status[error.code] ?? `status ${error.code}`;
    let waitMs: number | null = null;
    if (problem !== undefined) {
      const seconds = Number(textOf(error.metadata, "retry-after"));
      if (Number.isInteger(seconds) && seconds > 0) waitMs = seconds * 1000;
    }
    const tooLong = waitMs !== null && waitMs > this.retryAfterMaxMs;
    const text = `trading answered ${name}${problem ? ` ${problem.slice(0, 64)}` : ""}${waitMs === null ? "" : ` (retry-after ${waitMs / 1000} s)`}: ${error.details}`;
    return new CallFailure(text, RETRYABLE.has(error.code) && !tooLong, tooLong ? null : waitMs);
  }
}
