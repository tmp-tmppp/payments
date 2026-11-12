import type { DebitOutcome, DebitRequest, Trading } from "../../usecases/ports.js";

export interface FakeTradingOptions {
  /** Credits of a user nobody set a balance for. Default 1 000 000, so that a local run can withdraw. */
  defaultCredits?: number;
}

/**
 * Trading's debit endpoint (contracts/trading-debit.openapi.yaml) in memory, for APP_ENV=local and for the use-case tests:
 * idempotent by withdrawal id (a repeat answers debited and takes nothing again), insufficient when the credits are too
 * few. Test hooks make it misbehave like the real one can: `loseNextAnswers` debits and then reports no definitive answer
 * (the answer was lost), `answerNext` replaces the next outcomes (circuit open, unknown) without touching any balance.
 */
export class FakeTrading implements Trading {
  /** Every request, in order, including repeats. */
  readonly requests: DebitRequest[] = [];
  private readonly credits = new Map<string, number>();
  private readonly debited = new Set<string>();
  private readonly forced: DebitOutcome[] = [];
  private lost = 0;
  private readonly defaultCredits: number;

  constructor(options: FakeTradingOptions = {}) {
    this.defaultCredits = options.defaultCredits ?? 1_000_000;
  }

  setCredits(tenantId: string, userId: string, amount: number): void {
    this.credits.set(this.key(tenantId, userId), amount);
  }

  creditsOf(tenantId: string, userId: string): number {
    return this.credits.get(this.key(tenantId, userId)) ?? this.defaultCredits;
  }

  hasDebited(withdrawalId: string): boolean {
    return this.debited.has(withdrawalId);
  }

  /** The next calls answer with these outcomes, in order, before anything is looked at. */
  answerNext(...outcomes: DebitOutcome[]): void {
    this.forced.push(...outcomes);
  }

  /** The next n debits take the credits, but the caller gets "unknown": the answer was lost on the way. */
  loseNextAnswers(n: number): void {
    this.lost = n;
  }

  /** The credits of a debited withdrawal go back (what trading does after WithdrawalFailed). */
  refund(tenantId: string, userId: string, withdrawalId: string, amount: number): void {
    if (!this.debited.delete(withdrawalId)) return;
    this.setCredits(tenantId, userId, this.creditsOf(tenantId, userId) + amount);
  }

  debit(request: DebitRequest): Promise<DebitOutcome> {
    this.requests.push({ ...request });
    const forced = this.forced.shift();
    if (forced) return Promise.resolve(forced);
    if (!this.debited.has(request.withdrawalId)) {
      const available = this.creditsOf(request.tenantId, request.userId);
      if (available < request.amount) return Promise.resolve({ kind: "insufficient" });
      this.setCredits(request.tenantId, request.userId, available - request.amount);
      this.debited.add(request.withdrawalId);
    }
    if (this.lost > 0) {
      this.lost -= 1;
      return Promise.resolve({ kind: "unknown", reason: "the answer was lost" });
    }
    return Promise.resolve({ kind: "debited" });
  }

  private key(tenantId: string, userId: string): string {
    return `${tenantId}/${userId}`;
  }
}
