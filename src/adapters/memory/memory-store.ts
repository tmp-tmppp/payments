import { isUuid } from "../../domain/consumed-events.js";
import type { Deposit } from "../../domain/deposit.js";
import type { Withdrawal } from "../../domain/withdrawal.js";
import { TenantNotReady } from "../../usecases/errors.js";
import type {
  DepositRepository,
  OutboxRow,
  Repositories,
  Store,
  TenantRepositories,
  WithdrawalRepository,
} from "../../usecases/ports.js";

interface TenantState {
  deposits: Deposit[];
  withdrawals: Withdrawal[];
}

interface State {
  outbox: OutboxRow[];
  inbox: Array<{ consumer: string; id: string; type: string; at: Date }>;
  providerEvents: Array<{ id: string; type: string; objectId: string; at: Date }>;
  /** Tenants with a schema, by id (lower case). */
  tenants: Map<string, TenantState>;
}

const emptyState = (): State => ({ outbox: [], inbox: [], providerEvents: [], tenants: new Map() });

const byDueThenId = <T extends { id: string }>(due: (row: T) => Date | null) => (a: T, b: T): number =>
  (due(a)?.getTime() ?? 0) - (due(b)?.getTime() ?? 0) || a.id.localeCompare(b.id);

function sharedRepositories(state: () => State): Repositories {
  return {
    outbox: {
      add(message) {
        state().outbox.push({ ...message, publishedAt: null, attempts: 0, lastError: null });
        return Promise.resolve();
      },
      claimBatch: (limit) =>
        Promise.resolve(
          state()
            .outbox.filter((row) => row.publishedAt === null)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, limit)
            .map((row) => ({ ...row })),
        ),
      markPublished(id, at) {
        const row = state().outbox.find((candidate) => candidate.id === id);
        if (row) row.publishedAt = at;
        return Promise.resolve();
      },
      markFailed(id, error) {
        const row = state().outbox.find((candidate) => candidate.id === id);
        if (row) {
          row.attempts += 1;
          row.lastError = error;
        }
        return Promise.resolve();
      },
      purgePublished(olderThan) {
        const rows = state().outbox;
        const kept = rows.filter((row) => row.publishedAt === null || row.publishedAt.getTime() >= olderThan.getTime());
        const purged = rows.length - kept.length;
        rows.splice(0, rows.length, ...kept);
        return Promise.resolve(purged);
      },
    },
    inbox: {
      markProcessed(consumer, event, at) {
        const rows = state().inbox;
        if (rows.some((row) => row.consumer === consumer && row.id === event.id)) return Promise.resolve(false);
        rows.push({ consumer, id: event.id, type: event.type, at });
        return Promise.resolve(true);
      },
      purgeProcessed(olderThan) {
        const rows = state().inbox;
        const kept = rows.filter((row) => row.at.getTime() >= olderThan.getTime());
        const purged = rows.length - kept.length;
        rows.splice(0, rows.length, ...kept);
        return Promise.resolve(purged);
      },
    },
    providerEvents: {
      markReceived(event, at) {
        const rows = state().providerEvents;
        if (rows.some((row) => row.id === event.id)) return Promise.resolve(false);
        rows.push({ id: event.id, type: event.type, objectId: event.objectId, at });
        return Promise.resolve(true);
      },
      purgeReceived(olderThan) {
        const rows = state().providerEvents;
        const kept = rows.filter((row) => row.at.getTime() >= olderThan.getTime());
        const purged = rows.length - kept.length;
        rows.splice(0, rows.length, ...kept);
        return Promise.resolve(purged);
      },
    },
    tenants: {
      list: () => Promise.resolve([...state().tenants.keys()].sort()),
      exists: (tenantId) => Promise.resolve(isUuid(tenantId) && state().tenants.has(tenantId.toLowerCase())),
      provision(tenantId) {
        if (!isUuid(tenantId)) return Promise.reject(new Error("A tenant id must be a UUID"));
        const id = tenantId.toLowerCase();
        if (!state().tenants.has(id)) state().tenants.set(id, { deposits: [], withdrawals: [] });
        return Promise.resolve();
      },
    },
  };
}

function depositRepository(tenant: () => TenantState, tenantId: string): DepositRepository {
  const copy = (deposit: Deposit | undefined): Deposit | null => (deposit ? { ...deposit, tenantId } : null);
  return {
    insert(deposit) {
      const rows = tenant().deposits;
      if (rows.some((row) => row.userId === deposit.userId && row.idempotencyKey === deposit.idempotencyKey)) return Promise.resolve(false);
      if (rows.some((row) => row.id === deposit.id)) return Promise.reject(new Error(`The deposit ${deposit.id} exists`));
      if (deposit.providerSessionId !== null && rows.some((row) => row.providerSessionId === deposit.providerSessionId)) {
        return Promise.reject(new Error("The checkout session belongs to another deposit"));
      }
      rows.push({ ...deposit });
      return Promise.resolve(true);
    },
    get: (id) => Promise.resolve(copy(tenant().deposits.find((row) => row.id === id))),
    findByIdempotencyKey: (userId, key) => Promise.resolve(copy(tenant().deposits.find((row) => row.userId === userId && row.idempotencyKey === key))),
    save(deposit) {
      const rows = tenant().deposits;
      const index = rows.findIndex((row) => row.id === deposit.id);
      if (index < 0) return Promise.reject(new Error(`The deposit ${deposit.id} does not exist`));
      rows[index] = { ...deposit };
      return Promise.resolve();
    },
    claimDue: (now, limit) =>
      Promise.resolve(
        tenant()
          .deposits.filter((row) => row.status === "pending" && row.nextCheckAt !== null && row.nextCheckAt.getTime() <= now.getTime())
          .sort(byDueThenId((row) => row.nextCheckAt))
          .slice(0, limit)
          .map((row) => ({ ...row, tenantId })),
      ),
  };
}

function withdrawalRepository(tenant: () => TenantState, tenantId: string): WithdrawalRepository {
  const copy = (withdrawal: Withdrawal | undefined): Withdrawal | null => (withdrawal ? { ...withdrawal, tenantId } : null);
  const due = (status: "requested" | "debited", field: "nextDebitAt" | "nextPayoutAt", now: Date, limit: number): Withdrawal[] =>
    tenant()
      .withdrawals.filter((row) => row.status === status && row[field] !== null && row[field].getTime() <= now.getTime())
      .sort(byDueThenId((row) => row[field]))
      .slice(0, limit)
      .map((row) => ({ ...row, tenantId }));
  return {
    insert(withdrawal) {
      const rows = tenant().withdrawals;
      if (rows.some((row) => row.userId === withdrawal.userId && row.idempotencyKey === withdrawal.idempotencyKey)) return Promise.resolve(false);
      if (rows.some((row) => row.id === withdrawal.id)) return Promise.reject(new Error(`The withdrawal ${withdrawal.id} exists`));
      rows.push({ ...withdrawal });
      return Promise.resolve(true);
    },
    get: (id) => Promise.resolve(copy(tenant().withdrawals.find((row) => row.id === id))),
    findByIdempotencyKey: (userId, key) => Promise.resolve(copy(tenant().withdrawals.find((row) => row.userId === userId && row.idempotencyKey === key))),
    save(withdrawal) {
      const rows = tenant().withdrawals;
      const index = rows.findIndex((row) => row.id === withdrawal.id);
      if (index < 0) return Promise.reject(new Error(`The withdrawal ${withdrawal.id} does not exist`));
      rows[index] = { ...withdrawal };
      return Promise.resolve();
    },
    claimDebitDue: (now, limit) => Promise.resolve(due("requested", "nextDebitAt", now, limit)),
    claimPayoutDue: (now, limit) => Promise.resolve(due("debited", "nextPayoutAt", now, limit)),
  };
}

/**
 * In-memory store for unit tests and for local runs without a database (APP_ENV=local only). A transaction works on a
 * copy of the data and replaces it on success, so a failed transaction leaves nothing behind; transactions run one by one.
 * Like the PostgreSQL store it refuses a tenant without a schema (TenantNotReady) and keeps the tenants apart.
 */
export class MemoryStore implements Store {
  private state: State = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  readonly repositories: Repositories = sharedRepositories(() => this.state);

  private run<T>(work: (draft: State) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await work(draft);
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.run((draft) => work(sharedRepositories(() => draft)));
  }

  tenantTransaction<T>(tenantId: string, work: (repositories: TenantRepositories) => Promise<T>): Promise<T> {
    return this.run((draft) => {
      if (!isUuid(tenantId)) throw new Error("A tenant id must be a UUID");
      const id = tenantId.toLowerCase();
      if (!draft.tenants.has(id)) throw new TenantNotReady(id);
      const tenant = (): TenantState => draft.tenants.get(id) as TenantState;
      return work({
        ...sharedRepositories(() => draft),
        deposits: depositRepository(tenant, id),
        withdrawals: withdrawalRepository(tenant, id),
      });
    });
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  /** A deep copy of everything stored, for assertions in tests. */
  snapshot(): State {
    return structuredClone(this.state);
  }
}
