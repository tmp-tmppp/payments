import pg from "pg";
import type { CloudEvent } from "../../domain/events.js";
import type { Logger, OutboxRow, Repositories, Store, TenantRepositories } from "../../usecases/ports.js";
import {
  depositRepository,
  inboxRepository,
  providerEventRepository,
  tenantRegistryRepository,
  withdrawalRepository,
} from "./postgres-repositories.js";
import { useTenantSchema } from "./tenant-scope.js";

type Queryable = Pick<pg.Pool, "query">;

// Key of the advisory lock that lets one outbox relay claim at a time. Advisory locks of a database share one key
// space; the migration lock (migrate.ts) is 726001, so this one is the next number.
export const OUTBOX_RELAY_LOCK_KEY = 726_002;

interface OutboxDbRow {
  id: string;
  aggregate_id: string;
  subject: string;
  type: string;
  payload: CloudEvent<unknown>;
  created_at: Date;
  published_at: Date | null;
  attempts: number;
  last_error: string | null;
}

const toOutboxRow = (row: OutboxDbRow): OutboxRow => ({
  id: row.id,
  aggregateId: row.aggregate_id,
  subject: row.subject,
  type: row.type,
  payload: row.payload,
  createdAt: row.created_at,
  publishedAt: row.published_at,
  attempts: row.attempts,
  lastError: row.last_error,
});

/** The shared repositories over one connection (inside a transaction) or over the pool (each call on its own). */
export function repositoriesOver(db: Queryable, inTransaction: boolean, logger: Logger): Repositories {
  return {
    inbox: inboxRepository(db),
    providerEvents: providerEventRepository(db),
    tenants: tenantRegistryRepository(db, inTransaction, logger),
    outbox: {
      async add(message) {
        await db.query(
          `INSERT INTO shared.outbox (id, aggregate_id, subject, type, payload, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [message.id, message.aggregateId, message.subject, message.type, JSON.stringify(message.payload), message.createdAt],
        );
      },
      async claimBatch(limit) {
        // One relay at a time: the batches of the instances must not be published in parallel, or the events of a
        // tenant could arrive out of order. The lock belongs to the transaction (it ends with COMMIT or ROLLBACK,
        // also when the connection breaks), so a relay that crashes cannot keep it. Outside a transaction it would
        // be released at once; the relay always claims inside one.
        const lock = await db.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [OUTBOX_RELAY_LOCK_KEY]);
        if (lock.rows[0]?.locked !== true) return [];
        const result = await db.query<OutboxDbRow>(
          `SELECT * FROM shared.outbox
            WHERE published_at IS NULL
            ORDER BY created_at, id
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          [limit],
        );
        return result.rows.map(toOutboxRow);
      },
      async markPublished(id, at) {
        await db.query("UPDATE shared.outbox SET published_at = $2 WHERE id = $1", [id, at]);
      },
      async markFailed(id, error) {
        await db.query("UPDATE shared.outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1", [id, error]);
      },
      async purgePublished(olderThan) {
        const result = await db.query("DELETE FROM shared.outbox WHERE published_at IS NOT NULL AND published_at < $1", [olderThan]);
        return result.rowCount ?? 0;
      },
    },
  };
}

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class PostgresStore implements Store {
  readonly repositories: Repositories;

  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger = silent,
  ) {
    this.repositories = repositoriesOver(pool, false, logger);
  }

  /** One transaction on one connection: BEGIN, the work, COMMIT; ROLLBACK when the work throws. */
  private async inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.inTransaction((client) => work(repositoriesOver(client, true, this.logger)));
  }

  tenantTransaction<T>(tenantId: string, work: (repositories: TenantRepositories) => Promise<T>): Promise<T> {
    return this.inTransaction(async (client) => {
      await useTenantSchema(client, tenantId);
      const id = tenantId.toLowerCase();
      return work({
        ...repositoriesOver(client, true, this.logger),
        deposits: depositRepository(client, id),
        withdrawals: withdrawalRepository(client, id),
      });
    });
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}

export function createPool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({ connectionString, max, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30_000 });
}
