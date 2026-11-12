import { PaymentProviderKeyReused, PaymentProviderRejected, PaymentProviderUnavailable } from "../../usecases/errors.js";
import type { CreateCheckoutSessionInput, CreatePayoutInput, PaymentProvider, ProviderCheckoutSession, ProviderPayout } from "../../usecases/ports.js";

/**
 * The payment provider in memory, for APP_ENV=local and for the use-case tests. It keeps what the real one keeps (sessions,
 * payouts, idempotency by key) and, like the real one, forgets everything when `restart()` is called. The test hooks play the
 * buyer (`pay`, `decline`, `expire`) and the provider's payout settlement (`settlePayouts`, with `declinePayouts` for its
 * test mode); `failNext` makes the next calls fail like an outage and `loseNextAnswers` lets the call happen but loses its
 * answer (a timeout after the request was sent). A session lives `sessionTtlMs` (30 minutes like the real default) and turns
 * "expired" when it is read after that. Nothing here is sent anywhere.
 */
export class FakePaymentProvider implements PaymentProvider {
  /** Names of the calls made, in order: "createCheckoutSession", "getPayout", ... */
  readonly calls: string[] = [];
  /** Like the provider's test mode: payouts that settle from now on fail with "declined". */
  declinePayouts = false;
  private sessions = new Map<string, ProviderCheckoutSession>();
  private payouts = new Map<string, ProviderPayout>();
  private keys = new Map<string, { body: string; id: string }>();
  private failures: Error[] = [];
  private lostAnswers = new Map<string, number>();
  private counter = 0;

  constructor(
    private readonly options: { now?: () => Date; sessionTtlMs?: number } = {},
  ) {}

  /** The session lifetime; changeable by a test. */
  get sessionTtlMs(): number {
    return this.options.sessionTtlMs ?? 30 * 60_000;
  }
  set sessionTtlMs(value: number) {
    this.options.sessionTtlMs = value;
  }

  /** The next `count` calls of `call` ("createPayout", ...) are carried out, but their answer is lost: they fail like a timeout. */
  loseNextAnswers(call: string, count: number): void {
    this.lostAnswers.set(call, (this.lostAnswers.get(call) ?? 0) + count);
  }

  /** The next calls throw these errors, in order (for example a PaymentProviderUnavailable). */
  failNext(...errors: Error[]): void {
    this.failures.push(...errors);
  }

  /** The provider restarted: it forgets sessions, payouts and idempotency keys. */
  restart(): void {
    this.sessions = new Map();
    this.payouts = new Map();
    this.keys = new Map();
  }

  /** The buyer pays / declines / lets the session run out. Throws for a session that is not open. */
  pay(sessionId: string): void {
    this.closeSession(sessionId, "completed");
  }
  decline(sessionId: string): void {
    this.closeSession(sessionId, "declined");
  }
  expire(sessionId: string): void {
    this.closeSession(sessionId, "expired");
  }

  /** Settles every pending payout: paid, or failed ("declined") while `declinePayouts` is on. */
  settlePayouts(): void {
    for (const [id, payout] of this.payouts) {
      if (payout.status !== "pending") continue;
      this.payouts.set(id, this.declinePayouts ? { ...payout, status: "failed", failureReason: "declined" } : { ...payout, status: "paid" });
    }
  }

  sessionList(): ProviderCheckoutSession[] {
    return [...this.sessions.values()];
  }

  payoutList(): ProviderPayout[] {
    return [...this.payouts.values()];
  }

  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<ProviderCheckoutSession> {
    return this.run("createCheckoutSession", () => {
      const body = JSON.stringify([input.amount, input.tenantId, input.successUrl, input.cancelUrl]);
      const known = this.keys.get(`session:${input.depositId}`);
      if (known) {
        if (known.body !== body) throw new PaymentProviderKeyReused("The Idempotency-Key was used with another body");
        return this.requireSession(known.id);
      }
      const id = this.newId("cs");
      const session: ProviderCheckoutSession = {
        id,
        url: `http://localhost:8080/checkout/${id}`,
        status: "open",
        amount: input.amount,
        expiresAt: new Date((this.options.now ?? (() => new Date()))().getTime() + this.sessionTtlMs),
        metadata: { tenantId: input.tenantId, depositId: input.depositId },
      };
      this.sessions.set(id, session);
      this.keys.set(`session:${input.depositId}`, { body, id });
      return session;
    });
  }

  getCheckoutSession(id: string): Promise<ProviderCheckoutSession | null> {
    return this.run("getCheckoutSession", () => {
      const session = this.sessions.get(id) ?? null;
      if (session?.status === "open" && session.expiresAt !== null && session.expiresAt.getTime() <= (this.options.now ?? (() => new Date()))().getTime()) {
        const expired: ProviderCheckoutSession = { ...session, status: "expired" };
        this.sessions.set(id, expired);
        return expired;
      }
      return session;
    });
  }

  createPayout(input: CreatePayoutInput): Promise<ProviderPayout> {
    return this.run("createPayout", () => {
      const body = JSON.stringify([input.amount, input.tenantId, input.userId]);
      const known = this.keys.get(`payout:${input.withdrawalId}`);
      if (known) {
        if (known.body !== body) throw new PaymentProviderKeyReused("The Idempotency-Key was used with another body");
        return this.requirePayout(known.id);
      }
      const id = this.newId("po");
      const payout: ProviderPayout = {
        id,
        status: "pending",
        amount: input.amount,
        destination: input.userId,
        metadata: { tenantId: input.tenantId, withdrawalId: input.withdrawalId },
        failureReason: null,
      };
      this.payouts.set(id, payout);
      this.keys.set(`payout:${input.withdrawalId}`, { body, id });
      return payout;
    });
  }

  getPayout(id: string): Promise<ProviderPayout | null> {
    return this.run("getPayout", () => this.payouts.get(id) ?? null);
  }

  private run<T>(name: string, work: () => T): Promise<T> {
    this.calls.push(name);
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    try {
      const result = work();
      const lost = this.lostAnswers.get(name) ?? 0;
      if (lost > 0) {
        this.lostAnswers.set(name, lost - 1);
        return Promise.reject(new PaymentProviderUnavailable(`The answer to ${name} was lost (timeout)`));
      }
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new PaymentProviderUnavailable(String(error)));
    }
  }

  private newId(prefix: "cs" | "po"): string {
    this.counter += 1;
    return `${prefix}_${String(this.counter).padStart(24, "0")}`;
  }

  private requireSession(id: string): ProviderCheckoutSession {
    const session = this.sessions.get(id);
    if (!session) throw new PaymentProviderRejected(404, null, "The session is gone");
    return session;
  }

  private requirePayout(id: string): ProviderPayout {
    const payout = this.payouts.get(id);
    if (!payout) throw new PaymentProviderRejected(404, null, "The payout is gone");
    return payout;
  }

  private closeSession(id: string, status: "completed" | "declined" | "expired"): void {
    const session = this.requireSession(id);
    if (session.status !== "open") throw new Error(`The session ${id} is ${session.status}, not open`);
    this.sessions.set(id, { ...session, status });
  }
}
