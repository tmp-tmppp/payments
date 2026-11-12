import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIRS, migrateTenantSchema, provisionTenantSchema, runMigrations, tenantSchemaName } from "../../src/adapters/postgres/migrate.js";
import { createPool } from "../../src/adapters/postgres/postgres-store.js";
import { RecordingLogger } from "../support/harness.js";

// These tests need a running Docker daemon: "npm run test:integration". They are not part of "npm test".

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let extraDir: string;
const logger = new RecordingLogger();
const now = new Date("2026-11-01T10:00:00.000Z");
const T1 = "00000000-0000-7000-8000-000000000001";
const T2 = "00000000-0000-7000-8000-000000000002";
const T3 = "00000000-0000-7000-8000-000000000003";
const T4 = "00000000-0000-7000-8000-000000000004";

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18").withDatabase("payments").start();
  pool = createPool(container.getConnectionUri(), 8);
  extraDir = await mkdtemp(join(tmpdir(), "payments-tenant-migrations-"));
  await copyFile(fileURLToPath(new URL("001_init.sql", MIGRATIONS_DIRS.tenant)), join(extraDir, "001_init.sql"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (extraDir) await rm(extraDir, { recursive: true, force: true });
});

const schemaExists = async (name: string): Promise<boolean> =>
  ((await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [name])).rowCount ?? 0) > 0;
const columns = async (schema: string, table: string): Promise<string[]> =>
  (await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [schema, table])).rows.map((row) => row.column_name);

/** Runs statements with the tenant schema as the search path, like the tenant migrations do. */
async function inTenant<T>(tenantId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${tenantSchemaName(tenantId)}"`);
    return await work(client);
  } finally {
    await client.query("RESET search_path");
    client.release();
  }
}

const violation = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "no code";
  }
  return "none";
};

describe("shared migrations", () => {
  it("create the shared tables and apply nothing on a second run", async () => {
    const first = await runMigrations(pool, logger);
    expect(first).toEqual({ shared: ["001_init.sql"], tenants: {} });
    const tables = (await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'shared' ORDER BY table_name")).rows.map((row) => row.table_name);
    expect(tables).toEqual(["inbox", "outbox", "provider_events", "schema_migrations", "tenant_registry"]);
    expect(await runMigrations(pool, logger)).toEqual({ shared: [], tenants: {} });
  });

  it("guard the shared tables with constraints", async () => {
    await pool.query("INSERT INTO shared.inbox (consumer, event_id, event_type, processed_at) VALUES ('tenant-created', 'e1', 't', $1)", [now]);
    expect(await violation(pool.query("INSERT INTO shared.inbox (consumer, event_id, event_type, processed_at) VALUES ('tenant-created', 'e1', 't', $1)", [now]))).toBe("23505");
    await pool.query("INSERT INTO shared.inbox (consumer, event_id, event_type, processed_at) VALUES ('withdrawal-refunded', 'e1', 't', $1)", [now]);

    await pool.query("INSERT INTO shared.provider_events (event_id, event_type, object_id, received_at) VALUES ('evt_1', 'payout.paid', 'po_1', $1)", [now]);
    expect(await violation(pool.query("INSERT INTO shared.provider_events (event_id, event_type, object_id, received_at) VALUES ('evt_1', 'payout.paid', 'po_1', $1)", [now]))).toBe("23505");

    const wrongSchema = "INSERT INTO shared.tenant_registry (tenant_id, schema_name, created_at) VALUES ($1, 'tenant_ffffffffffffffffffffffffffffffff', $2)";
    expect(await violation(pool.query(wrongSchema, [T1, now]))).toBe("23514");
    expect(await violation(pool.query("INSERT INTO shared.tenant_registry (tenant_id, schema_name, created_at) VALUES ($1, 'public', $2)", [T1, now]))).toBe("23514");
  });
});

describe("tenant schemas", () => {
  it("are created, migrated and registered by provisionTenantSchema, and the call is idempotent", async () => {
    await migrateTenantSchema(pool, T1, now, logger);
    await migrateTenantSchema(pool, T2, now, logger);

    for (const id of [T1, T2]) {
      const schema = tenantSchemaName(id);
      expect(await columns(schema, "deposits")).toContain("provider_session_id");
      expect(await columns(schema, "withdrawals")).toContain("next_debit_at");
      expect((await pool.query(`SELECT version FROM "${schema}".schema_migrations`)).rows).toEqual([{ version: "001_init.sql" }]);
    }
    expect((await pool.query("SELECT tenant_id, schema_name FROM shared.tenant_registry ORDER BY tenant_id")).rows).toEqual([
      { tenant_id: T1, schema_name: tenantSchemaName(T1) },
      { tenant_id: T2, schema_name: tenantSchemaName(T2) },
    ]);
    expect(await migrateTenantSchema(pool, T1, now, logger)).toEqual([]);
  });

  it("keep nothing behind when the transaction of the inbox rolls back, and leave the search path alone", async () => {
    const client = await pool.connect();
    try {
      const before = (await client.query<{ search_path: string }>("SHOW search_path")).rows[0]?.search_path;
      await client.query("BEGIN");
      await provisionTenantSchema(client, T3, now, logger);
      expect((await client.query<{ search_path: string }>("SHOW search_path")).rows[0]?.search_path).toBe(before);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await schemaExists(tenantSchemaName(T3))).toBe(false);
    expect((await pool.query("SELECT 1 FROM shared.tenant_registry WHERE tenant_id = $1", [T3])).rowCount).toBe(0);
  });

  it("get a new tenant migration at the next start, every registered schema alike", async () => {
    await migrateTenantSchema(pool, T3, now, logger);
    await writeFile(join(extraDir, "002_add_note.sql"), "ALTER TABLE deposits ADD COLUMN note text;\n");
    const directories = { shared: MIGRATIONS_DIRS.shared, tenant: pathToFileURL(`${extraDir}/`) };

    const report = await runMigrations(pool, logger, directories);

    expect(report.shared).toEqual([]);
    expect(report.tenants).toEqual({
      [tenantSchemaName(T1)]: ["002_add_note.sql"],
      [tenantSchemaName(T2)]: ["002_add_note.sql"],
      [tenantSchemaName(T3)]: ["002_add_note.sql"],
    });
    for (const id of [T1, T2, T3]) expect(await columns(tenantSchemaName(id), "deposits")).toContain("note");

    // A tenant created later gets every file at once; the schemas agree.
    expect(await migrateTenantSchema(pool, T4, now, logger, directories)).toEqual(["001_init.sql", "002_add_note.sql"]);
    expect(await columns(tenantSchemaName(T4), "deposits")).toEqual(await columns(tenantSchemaName(T1), "deposits"));
    expect(await columns(tenantSchemaName(T4), "withdrawals")).toEqual(await columns(tenantSchemaName(T2), "withdrawals"));
  });

  it("stop the run when an applied file was changed", async () => {
    await writeFile(join(extraDir, "002_add_note.sql"), "ALTER TABLE deposits ADD COLUMN note text; -- edited\n");
    await expect(runMigrations(pool, logger, { shared: MIGRATIONS_DIRS.shared, tenant: pathToFileURL(`${extraDir}/`) })).rejects.toThrow(/was changed after it was applied/);
  });

  it("run once at a time: two starts at once end with every file applied once", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "payments-two-starts-"));
    try {
      const other = createPool(container.getConnectionUri(), 4);
      const [a, b] = await Promise.all([
        runMigrations(pool, logger, { shared: MIGRATIONS_DIRS.shared, tenant: MIGRATIONS_DIRS.tenant }),
        runMigrations(other, logger, { shared: MIGRATIONS_DIRS.shared, tenant: MIGRATIONS_DIRS.tenant }),
      ]);
      await other.end();
      expect(a.shared).toEqual([]);
      expect(b.shared).toEqual([]);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe("tenant tables", () => {
  const deposit = (overrides: Record<string, unknown> = {}) => {
    const row = {
      id: crypto.randomUUID(),
      user_id: "user-1",
      amount: 2500,
      status: "pending",
      idempotency_key: crypto.randomUUID(),
      request_hash: "h",
      expires_at: new Date(now.getTime() + 30 * 60_000),
      next_check_at: new Date(now.getTime() + 30 * 60_000),
      created_at: now,
      updated_at: now,
      ...overrides,
    };
    const keys = Object.keys(row);
    return { sql: `INSERT INTO deposits (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, values: Object.values(row) };
  };
  const withdrawal = (overrides: Record<string, unknown> = {}) => {
    const row = {
      id: crypto.randomUUID(),
      user_id: "user-1",
      amount: 1800,
      status: "requested",
      idempotency_key: crypto.randomUUID(),
      request_hash: "h",
      next_debit_at: now,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
    const keys = Object.keys(row);
    return { sql: `INSERT INTO withdrawals (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, values: Object.values(row) };
  };

  it("accept a pending deposit and refuse amounts outside 1 to 1 000 000", async () => {
    await inTenant(T1, async (client) => {
      const ok = deposit();
      await client.query(ok.sql, ok.values);
      for (const amount of [0, -1, 1_000_001]) {
        const bad = deposit({ amount });
        expect(await violation(client.query(bad.sql, bad.values)), String(amount)).toBe("23514");
      }
      for (const amount of [1, 1_000_000]) {
        const edge = deposit({ amount });
        await client.query(edge.sql, edge.values);
      }
    });
  });

  it("keep one resource per user and Idempotency-Key, and allow the key for another user", async () => {
    await inTenant(T1, async (client) => {
      const first = deposit({ idempotency_key: "key-dup" });
      await client.query(first.sql, first.values);
      const again = deposit({ idempotency_key: "key-dup" });
      expect(await violation(client.query(again.sql, again.values))).toBe("23505");
      const other = deposit({ idempotency_key: "key-dup", user_id: "user-2" });
      await client.query(other.sql, other.values);
      const badKey = deposit({ idempotency_key: "has space" });
      expect(await violation(client.query(badKey.sql, badKey.values))).toBe("23514");
    });
  });

  it("tie the deposit's reason, end time and job time to its status", async () => {
    await inTenant(T1, async (client) => {
      const failedNoReason = deposit({ status: "failed", completed_at: now, next_check_at: null });
      expect(await violation(client.query(failedNoReason.sql, failedNoReason.values))).toBe("23514");
      const failedOk = deposit({ status: "failed", failure_reason: "expired", completed_at: now, next_check_at: null });
      await client.query(failedOk.sql, failedOk.values);
      const pendingNoCheck = deposit({ next_check_at: null });
      expect(await violation(client.query(pendingNoCheck.sql, pendingNoCheck.values))).toBe("23514");
      const halfSession = deposit({ provider_session_id: "cs_1" });
      expect(await violation(client.query(halfSession.sql, halfSession.values))).toBe("23514");
      const unknownStatus = deposit({ status: "done" });
      expect(await violation(client.query(unknownStatus.sql, unknownStatus.values))).toBe("23514");
    });
  });

  it("allow exactly the states, reasons and job times of the withdrawal saga", async () => {
    await inTenant(T2, async (client) => {
      const requested = withdrawal();
      await client.query(requested.sql, requested.values);
      const debited = withdrawal({ status: "debited", next_debit_at: null, next_payout_at: now });
      await client.query(debited.sql, debited.values);
      const failed = withdrawal({ status: "failed", reason: "forced", next_debit_at: null, provider_payout_id: null });
      await client.query(failed.sql, failed.values);
      const refunded = withdrawal({ status: "refunded", reason: "declined", next_debit_at: null, completed_at: now, provider_payout_id: "po_9" });
      await client.query(refunded.sql, refunded.values);
      const rejected = withdrawal({ status: "rejected", reason: "insufficient_credits", next_debit_at: null, completed_at: now });
      await client.query(rejected.sql, rejected.values);

      const bad: Array<[string, ReturnType<typeof withdrawal>]> = [
        ["unknown status", withdrawal({ status: "weird" })],
        ["rejected for a payout reason", withdrawal({ status: "rejected", reason: "declined", next_debit_at: null, completed_at: now })],
        ["failed for a debit reason", withdrawal({ status: "failed", reason: "insufficient_credits", next_debit_at: null })],
        ["requested with a reason", withdrawal({ reason: "forced" })],
        ["requested without a debit time", withdrawal({ next_debit_at: null })],
        ["debited without a payout time", withdrawal({ status: "debited", next_debit_at: null })],
        ["paid out without an end time", withdrawal({ status: "paid_out", next_debit_at: null })],
        ["a payout for a rejected withdrawal", withdrawal({ status: "rejected", reason: "insufficient_credits", next_debit_at: null, completed_at: now, provider_payout_id: "po_1" })],
        ["a payout before the debit", withdrawal({ provider_payout_id: "po_2" })],
        ["a negative attempt counter", withdrawal({ debit_attempts: -1 })],
        ["amount 0", withdrawal({ amount: 0 })],
      ];
      for (const [label, row] of bad) expect(await violation(client.query(row.sql, row.values)), label).toBe("23514");

      const payout = withdrawal({ status: "debited", next_debit_at: null, next_payout_at: now, provider_payout_id: "po_dup" });
      await client.query(payout.sql, payout.values);
      const samePayout = withdrawal({ status: "debited", next_debit_at: null, next_payout_at: now, provider_payout_id: "po_dup" });
      expect(await violation(client.query(samePayout.sql, samePayout.values))).toBe("23505");
    });
  });

  it("keep the tenants apart: a row of one tenant is not in the schema of another", async () => {
    const countIn = (tenantId: string) => inTenant(tenantId, async (client) => Number((await client.query<{ n: string }>("SELECT count(*) AS n FROM deposits WHERE user_id = 'only-in-t4'")).rows[0]?.n));
    await inTenant(T4, async (client) => {
      const row = deposit({ user_id: "only-in-t4" });
      await client.query(row.sql, row.values);
    });
    expect(await countIn(T4)).toBe(1);
    expect(await countIn(T1)).toBe(0);
    expect(await countIn(T2)).toBe(0);
  });
});
