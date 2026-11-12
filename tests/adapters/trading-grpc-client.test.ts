import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import type { AddressInfo, Server as TcpServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TradingClient } from "../../src/adapters/trading/trading-client.js";
import { TRADING_DEBIT_PROTO_FILE, TradingGrpcClient, loadDebitsClient } from "../../src/adapters/trading/trading-grpc-client.js";
import type { DebitOutcome, ServiceTokenSource } from "../../src/usecases/ports.js";
import { TENANT_A } from "../support/harness.js";

// An in-process gRPC server built from the same proto file answers each row of trading's status table
// (contracts/external/trading-debit.proto, "Status codes"), with and without the trailing metadata.

const WITHDRAWAL = "018f3c1e-7a00-7000-8000-000000000002";
const OTHER = "018f3c1e-7a00-7000-8000-000000000003";
const FAST = { timeoutMs: 400, maxAttempts: 3, retryInitialDelayMs: 1, retryMaxDelayMs: 5 } as const;
const request = { withdrawalId: WITHDRAWAL, tenantId: TENANT_A, userId: "user-1", amount: 300 };

interface Reply {
  withdrawal_id: string;
  status: string;
  amount: number;
}
interface Received {
  request: Record<string, unknown>;
  authorization: unknown;
  correlationId: unknown;
  /** Milliseconds from the arrival of the call to its deadline. */
  deadlineInMs: number;
}
/** What the stub answers: a reply, a status with trailing metadata, or nothing at all (the call hangs). */
type Answer = { reply: Reply } | { code: grpc.status; trailers?: Record<string, string> } | "hang";

const debitedReply = (overrides: Partial<Reply> = {}): Answer => ({ reply: { withdrawal_id: WITHDRAWAL, status: "DEBIT_STATUS_DEBITED", amount: 300, ...overrides } });
/** An answer of trading itself: its code, the correlation id and, for UNAVAILABLE, the seconds to wait. */
const fromTrading = (code: grpc.status, problem: string, extra: Record<string, string> = {}): Answer => ({
  code,
  trailers: { "chance-problem-code": problem, "x-correlation-id": "corr-from-trading", ...extra },
});

class StubTrading {
  readonly received: Received[] = [];
  answer: (call: number) => Answer = () => debitedReply();
  address = "";
  private readonly server = new grpc.Server({ "grpc.max_receive_message_length": 16 * 1024 });

  async start(): Promise<void> {
    this.server.addService(loadDebitsClient(TRADING_DEBIT_PROTO_FILE).service, {
      DebitCredits: (call: grpc.ServerUnaryCall<Record<string, unknown>, Reply>, callback: grpc.sendUnaryData<Reply>) => {
        const deadline = call.getDeadline();
        this.received.push({
          request: call.request,
          authorization: call.metadata.get("authorization")[0],
          correlationId: call.metadata.get("x-correlation-id")[0],
          deadlineInMs: (deadline instanceof Date ? deadline.getTime() : deadline) - Date.now(),
        });
        const answer = this.answer(this.received.length);
        if (answer === "hang") return;
        if ("reply" in answer) return callback(null, answer.reply);
        const metadata = new grpc.Metadata();
        for (const [key, value] of Object.entries(answer.trailers ?? {})) metadata.set(key, value);
        callback({ code: answer.code, details: "a text for people", metadata });
      },
    });
    const port = await new Promise<number>((resolve, reject) =>
      this.server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) => (error ? reject(error) : resolve(bound))),
    );
    this.address = `127.0.0.1:${port}`;
  }

  stop(): void {
    this.server.forceShutdown();
  }

  reset(): void {
    this.received.length = 0;
    this.answer = () => debitedReply();
  }
}

/** A TCP proxy in front of the stub that can stop passing bytes on its open connections, as a peer that vanished does. */
class FreezingProxy {
  connections = 0;
  address = "";
  private readonly open: Array<{ client: Socket; upstream: Socket; frozen: boolean }> = [];
  private readonly server: TcpServer;

  constructor(target: string) {
    const [host = "", port = ""] = target.split(":");
    this.server = createTcpServer((client) => {
      this.connections += 1;
      const upstream = connect(Number(port), host);
      const pair = { client, upstream, frozen: false };
      this.open.push(pair);
      client.on("data", (chunk) => (pair.frozen ? undefined : upstream.write(chunk)));
      upstream.on("data", (chunk) => (pair.frozen ? undefined : client.write(chunk)));
      const end = (): void => {
        client.destroy();
        upstream.destroy();
      };
      for (const socket of [client, upstream]) {
        socket.on("error", end);
        socket.on("close", end);
      }
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.address = `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  freezeOpenConnections(): void {
    for (const pair of this.open) pair.frozen = true;
  }

  stop(): void {
    for (const { client, upstream } of this.open) {
      client.destroy();
      upstream.destroy();
    }
    this.server.close();
  }
}

/** The client-credentials token of the client payments: svc-1, then svc-2 after a refresh, and so on. */
class Tokens implements ServiceTokenSource {
  fetched = 0;
  invalidated = 0;
  failWith: Error | null = null;
  private current: string | null = null;

  getToken(): Promise<string> {
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.current === null) {
      this.fetched += 1;
      this.current = `svc-${this.fetched}`;
    }
    return Promise.resolve(this.current);
  }

  invalidate(): void {
    this.invalidated += 1;
    this.current = null;
  }
}

const stub = new StubTrading();
const opened: TradingGrpcClient[] = [];
let tokens: Tokens;
beforeAll(() => stub.start());
afterAll(() => stub.stop());
beforeEach(() => {
  stub.reset();
  tokens = new Tokens();
});
afterEach(() => {
  for (const client of opened.splice(0)) client.close();
});

const grpcTrading = (overrides: Partial<ConstructorParameters<typeof TradingGrpcClient>[0]> = {}): TradingGrpcClient => {
  const client = new TradingGrpcClient({ address: stub.address, tokens, ...FAST, ...overrides });
  opened.push(client);
  return client;
};

describe("TradingGrpcClient", () => {
  it("debits with the proto's fields, the service token, the correlation id and a deadline of the attempt's timeout", async () => {
    expect(await grpcTrading().debit({ ...request, correlationId: "corr-1" })).toEqual({ kind: "debited" });
    expect(stub.received).toHaveLength(1);
    const [call] = stub.received;
    expect(call?.request).toEqual({ withdrawal_id: WITHDRAWAL, tenant_id: TENANT_A, user_id: "user-1", amount: 300 });
    expect(call?.authorization).toBe("Bearer svc-1");
    expect(call?.correlationId).toBe("corr-1");
    expect(call?.deadlineInMs).toBeGreaterThan(0);
    expect(call?.deadlineInMs).toBeLessThanOrEqual(FAST.timeoutMs);
  });

  it("sends no x-correlation-id when the request has none, and reuses the cached token", async () => {
    const client = grpcTrading();
    expect(await client.debit(request)).toEqual({ kind: "debited" });
    expect(await client.debit(request)).toEqual({ kind: "debited" });
    expect(stub.received.map((call) => call.correlationId)).toEqual([undefined, undefined]);
    expect(tokens.fetched).toBe(1);
  });

  it("takes trading's lower-case withdrawal id as the same debit", async () => {
    expect(await grpcTrading().debit({ ...request, withdrawalId: WITHDRAWAL.toUpperCase() })).toEqual({ kind: "debited" });
  });

  it.each([
    ["another withdrawal id", debitedReply({ withdrawal_id: OTHER })],
    ["another amount", debitedReply({ amount: 299 })],
    ["the unspecified status", debitedReply({ status: "DEBIT_STATUS_UNSPECIFIED" })],
  ])("gives unknown, without a repeat, for an OK reply with %s", async (_name, answer) => {
    stub.answer = () => answer;
    expect(await grpcTrading().debit(request)).toEqual({ kind: "unknown", reason: expect.stringContaining("not a debit result") });
    expect(stub.received).toHaveLength(1);
  });

  // Trading's status table: the code, its chance-problem-code, and whether a repeat right away may help. Besides the rows
  // of the table: a FAILED_PRECONDITION with another code (trading maps every conflict of a use case to it, failure.ts),
  // trading's CANCELLED of a call that ended before the debit (code `cancelled`), and UNKNOWN and ABORTED as any server
  // or proxy may send them.
  const table: Array<[keyof typeof grpc.status, string, boolean]> = [
    ["FAILED_PRECONDITION", "insufficient_credits", false],
    ["FAILED_PRECONDITION", "another_conflict", false],
    ["ALREADY_EXISTS", "idempotency_key_reused", false],
    ["INVALID_ARGUMENT", "validation_failed", false],
    ["PERMISSION_DENIED", "forbidden", false],
    ["UNAVAILABLE", "concurrent_update", true],
    ["UNAVAILABLE", "identity_provider_unavailable", true],
    ["DEADLINE_EXCEEDED", "deadline_exceeded", true],
    ["INTERNAL", "internal_error", true],
    ["CANCELLED", "cancelled", true],
    ["UNKNOWN", "", true],
    ["ABORTED", "", true],
    ["RESOURCE_EXHAUSTED", "", false],
  ];
  // With the trailing metadata (trading's own answer) and, once per status, without it (as the library makes a status).
  const withoutTrailers = new Map(table.map(([name, , retryable]) => [name, retryable]));
  const rows = [
    ...table.filter(([, problem]) => problem).map(([name, problem, retryable]) => ({ label: `${name} with chance-problem-code ${problem}`, name, problem, retryable, trailers: true })),
    ...[...withoutTrailers].map(([name, retryable]) => ({ label: `${name} without the trailing metadata`, name, problem: "", retryable, trailers: false })),
  ];

  it.each(rows)("$label", async ({ name, problem, retryable, trailers }) => {
    const code = grpc.status[name];
    stub.answer = () => (trailers ? fromTrading(code, problem) : { code });
    const outcome = await grpcTrading().debit(request);
    if (name === "FAILED_PRECONDITION" && problem === "insufficient_credits") {
      // The one definitive refusal; a FAILED_PRECONDITION without this code, or with another, is not "too few credits".
      expect(outcome).toEqual({ kind: "insufficient" });
    } else {
      expect(outcome).toEqual({ kind: "unknown", reason: expect.stringContaining(`trading answered ${name}${trailers ? ` ${problem}` : ""}`) });
    }
    expect(stub.received).toHaveLength(retryable ? FAST.maxAttempts : 1);
  });

  it("repeats a call that was not definitive and debits when a repeat succeeds", async () => {
    stub.answer = (call) => (call === 1 ? { code: grpc.status.UNAVAILABLE } : debitedReply());
    expect(await grpcTrading().debit(request)).toEqual({ kind: "debited" });
    expect(stub.received).toHaveLength(2);
  });

  it("fetches a new token once after UNAUTHENTICATED and repeats; a second UNAUTHENTICATED is unknown", async () => {
    stub.answer = (call) => (call === 1 ? fromTrading(grpc.status.UNAUTHENTICATED, "unauthorized") : debitedReply());
    expect(await grpcTrading().debit(request)).toEqual({ kind: "debited" });
    expect(stub.received.map((call) => call.authorization)).toEqual(["Bearer svc-1", "Bearer svc-2"]);
    expect(tokens.invalidated).toBe(1);

    stub.reset();
    stub.answer = () => fromTrading(grpc.status.UNAUTHENTICATED, "unauthorized");
    expect(await grpcTrading().debit(request)).toEqual({ kind: "unknown", reason: expect.stringContaining("UNAUTHENTICATED unauthorized") });
    expect(stub.received).toHaveLength(2);
    expect(tokens.invalidated).toBe(2);
  });

  it("refreshes the token once also for an UNAUTHENTICATED without the trailing metadata", async () => {
    stub.answer = () => ({ code: grpc.status.UNAUTHENTICATED });
    expect(await grpcTrading().debit(request)).toEqual({ kind: "unknown", reason: expect.stringContaining("trading answered UNAUTHENTICATED: ") });
    expect(stub.received.map((call) => call.authorization)).toEqual(["Bearer svc-1", "Bearer svc-2"]);
    expect(tokens.invalidated).toBe(1);
  });

  it("never sends the debit of an attempt that was given up while its token was on the way", async () => {
    // A token source that ignores the signal and answers after the attempt's timeout.
    const late: ServiceTokenSource = {
      getToken: () => new Promise((resolve) => setTimeout(() => resolve("svc-late"), 250)),
      invalidate: () => undefined,
    };
    expect((await grpcTrading({ tokens: late, timeoutMs: 100, maxAttempts: 1 }).debit(request)).kind).toBe("unknown");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stub.received).toHaveLength(0);
  });

  it("drops a connection whose peer stopped answering and connects again (keepalive)", async () => {
    const proxy = new FreezingProxy(stub.address);
    await proxy.start();
    try {
      // The attempt's timeout outlasts the library's first reconnect wait (1 s and jitter), not the keepalive.
      const client = grpcTrading({ address: proxy.address, keepaliveTimeMs: 100, keepaliveTimeoutMs: 100, timeoutMs: 2500, maxAttempts: 3 });
      expect(await client.debit(request)).toEqual({ kind: "debited" });
      // trading's Pod is gone without closing the connection: nothing comes back on it, and the debit does not arrive.
      proxy.freezeOpenConnections();
      expect(await client.debit(request)).toEqual({ kind: "debited" });
      expect(proxy.connections).toBe(2);
      expect(stub.received).toHaveLength(2);
    } finally {
      proxy.stop();
    }
  });

  it("waits the retry-after of trading's own answer before the repeat, and its own short backoff without a code", async () => {
    stub.answer = (call) => (call === 1 ? fromTrading(grpc.status.UNAVAILABLE, "concurrent_update", { "retry-after": "1" }) : debitedReply());
    let started = Date.now();
    expect(await grpcTrading().debit(request)).toEqual({ kind: "debited" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);

    stub.reset();
    // retry-after without chance-problem-code is not trading's: the library made the status, the client's own backoff counts.
    stub.answer = (call) => (call === 1 ? { code: grpc.status.UNAVAILABLE, trailers: { "retry-after": "1" } } : debitedReply());
    started = Date.now();
    expect(await grpcTrading().debit(request)).toEqual({ kind: "debited" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("does not repeat inside the call when trading asks for a longer wait than the limit: the job repeats it later", async () => {
    stub.answer = () => fromTrading(grpc.status.UNAVAILABLE, "identity_provider_unavailable", { "retry-after": "2" });
    expect(await grpcTrading({ retryAfterMaxMs: 1000 }).debit(request)).toEqual({ kind: "unknown", reason: expect.stringContaining("retry-after 2 s") });
    expect(stub.received).toHaveLength(1);
  });

  it("gives unknown for the library's own statuses: a deadline that passes, a refused connection, a message over 16 KiB", async () => {
    stub.answer = () => "hang";
    expect((await grpcTrading({ timeoutMs: 100, maxAttempts: 2 }).debit(request)).kind).toBe("unknown");
    expect(stub.received).toHaveLength(2);

    stub.reset();
    const closed = new StubTrading();
    await closed.start();
    closed.stop();
    expect((await grpcTrading({ address: closed.address }).debit(request)).kind).toBe("unknown");

    const huge = await grpcTrading().debit({ ...request, userId: "x".repeat(20 * 1024) });
    expect(huge).toEqual({ kind: "unknown", reason: expect.stringContaining("RESOURCE_EXHAUSTED") });
    expect(stub.received).toHaveLength(0);
  });

  it("sends nothing when no token can be fetched", async () => {
    tokens.failWith = new TypeError("fetch failed");
    expect((await grpcTrading().debit(request)).kind).toBe("unknown");
    expect(stub.received).toHaveLength(0);
  });

  it("says circuit_open, and sends nothing, once the circuit is open before the call", async () => {
    stub.answer = () => fromTrading(grpc.status.INTERNAL, "internal_error");
    const fragile = grpcTrading({ maxAttempts: 1, breakerThreshold: 2, halfOpenAfterMs: 60_000 });
    expect((await fragile.debit(request)).kind).toBe("unknown");
    expect((await fragile.debit(request)).kind).toBe("unknown");
    expect(await fragile.debit(request)).toEqual({ kind: "circuit_open" });
    expect(stub.received).toHaveLength(2);
  });

  it("a circuit that opens in the middle of a call is unknown: the call had been sent", async () => {
    stub.answer = () => ({ code: grpc.status.UNAVAILABLE });
    expect(await grpcTrading({ maxAttempts: 3, breakerThreshold: 2, halfOpenAfterMs: 60_000 }).debit(request)).toEqual({ kind: "unknown", reason: expect.stringContaining("opened during the call") });
    expect(stub.received).toHaveLength(2);
  });

  it("closes its channel: a debit after close is unknown and sends nothing", async () => {
    const client = grpcTrading();
    client.close();
    expect((await client.debit(request)).kind).toBe("unknown");
    expect(stub.received).toHaveLength(0);
  });

  it("refuses a proto file without the service Debits", () => {
    const dir = mkdtempSync(join(tmpdir(), "payments-proto-"));
    const file = join(dir, "other.proto");
    writeFileSync(file, 'syntax = "proto3";\npackage chance.other.v1;\nmessage Nothing {}\n');
    expect(() => loadDebitsClient(file)).toThrow("does not define the service chance.trading.v1.Debits");
  });
});

describe("REST and gRPC give the same outcome for the same answer of trading", () => {
  let http: HttpServer;
  let restUrl = "";
  /** The REST answer of the current case: status and problem code (200 is the debit result). */
  let restAnswer: { status: number; code?: string } = { status: 200 };
  let restCalls = 0;

  beforeAll(async () => {
    http = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        restCalls += 1;
        const body = restAnswer.status === 200 ? { withdrawalId: WITHDRAWAL, status: "debited" } : { code: restAnswer.code ?? "unknown" };
        res.writeHead(restAnswer.status, { "content-type": restAnswer.status === 200 ? "application/json" : "application/problem+json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    restUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  beforeEach(() => {
    restCalls = 0;
  });

  // The REST status of the proposal and the gRPC status of trading's table with the same meaning.
  const cases: Array<[string, { status: number; code?: string }, Answer, DebitOutcome["kind"]]> = [
    ["debited", { status: 200 }, debitedReply(), "debited"],
    ["too few credits", { status: 409, code: "insufficient_credits" }, fromTrading(grpc.status.FAILED_PRECONDITION, "insufficient_credits"), "insufficient"],
    ["an invalid field", { status: 400, code: "validation_failed" }, fromTrading(grpc.status.INVALID_ARGUMENT, "validation_failed"), "unknown"],
    ["another client's token", { status: 403, code: "forbidden" }, fromTrading(grpc.status.PERMISSION_DENIED, "forbidden"), "unknown"],
    ["a reused withdrawal id", { status: 422, code: "idempotency_key_reused" }, fromTrading(grpc.status.ALREADY_EXISTS, "idempotency_key_reused"), "unknown"],
    ["a token refused every time", { status: 401, code: "unauthorized" }, fromTrading(grpc.status.UNAUTHENTICATED, "unauthorized"), "unknown"],
    ["trading busy", { status: 503, code: "concurrent_update" }, fromTrading(grpc.status.UNAVAILABLE, "concurrent_update"), "unknown"],
    ["a failure inside trading", { status: 500, code: "internal_error" }, fromTrading(grpc.status.INTERNAL, "internal_error"), "unknown"],
  ];

  it.each(cases)("%s", async (_name, rest, answer, kind) => {
    restAnswer = rest;
    stub.answer = () => answer;
    const viaRest = await new TradingClient({ baseUrl: restUrl, tokens: new Tokens(), ...FAST }).debit(request);
    const viaGrpc = await grpcTrading().debit(request);
    expect(viaRest.kind).toBe(kind);
    expect(viaGrpc.kind).toBe(kind);
    // The same number of attempts: the same answers are repeated, and the same are not.
    expect(stub.received).toHaveLength(restCalls);
  });

  it("differs on purpose for a conflict other than too few credits: REST takes every 409 as insufficient, gRPC only the code", async () => {
    // The REST proposal's only 409 is insufficient_credits; trading's FAILED_PRECONDITION stands for every conflict of a
    // use case (trading/src/web/grpc/failure.ts), so over gRPC only the code makes it definitive.
    restAnswer = { status: 409, code: "another_conflict" };
    stub.answer = () => fromTrading(grpc.status.FAILED_PRECONDITION, "another_conflict");
    expect((await new TradingClient({ baseUrl: restUrl, tokens: new Tokens(), ...FAST }).debit(request)).kind).toBe("insufficient");
    expect((await grpcTrading().debit(request)).kind).toBe("unknown");
    expect(stub.received).toHaveLength(1);
  });
});
