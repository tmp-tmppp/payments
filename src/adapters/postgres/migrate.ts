import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";
import type { Logger } from "../../usecases/ports.js";

// An arbitrary constant: every instance that migrates takes this advisory lock, so one migrates at a time.
const MIGRATION_LOCK_KEY = 726_001;
const FILE_PATTERN = /^(\d{3,})_[a-z0-9_]+\.sql$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MigrationDirectories {
  /** SQL for the shared schema; its statements name their tables with the prefix "shared.". */
  shared: URL;
  /** SQL for one tenant schema; it runs with that schema as the only entry of the search path, so names are not qualified. */
  tenant: URL;
}

/** The versioned SQL files, next to src/ (and next to dist/ in the image). */
export const MIGRATIONS_DIRS: MigrationDirectories = {
  shared: new URL("../../../migrations/shared/", import.meta.url),
  tenant: new URL("../../../migrations/tenant/", import.meta.url),
};

/** A pool client, or a pool: anything that runs a query. A function that takes a client does not open or close a transaction itself unless it says so. */
type Db = Pick<pg.PoolClient, "query">;

export interface MigrationReport {
  /** Files applied to the shared schema in this run. */
  shared: string[];
  /** Files applied in this run to each tenant schema that got any. */
  tenants: Record<string, string[]>;
}

/** The schema of a tenant: "tenant_" and the 32 hex digits of its id. The only code that turns an id into a schema name. */
export function tenantSchemaName(tenantId: string): string {
  if (!UUID_PATTERN.test(tenantId)) throw new Error("A tenant id must be a UUID");
  return `tenant_${tenantId.toLowerCase().replaceAll("-", "")}`;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
}

/** The files NNN_name.sql of a folder, in order. */
export async function readMigrationFiles(directory: URL): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => FILE_PATTERN.test(name)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(new URL(name, directory), "utf8");
      return { version: name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

/**
 * Applies the files of one folder that the schema has not recorded yet, in order, and records each one in the schema's
 * own schema_migrations table with a checksum. A file that was changed after it was applied stops the run: applied
 * migrations are never edited, a new file is added instead. With `ownTransactions` each file runs in its own
 * transaction; without, the caller has a transaction open and the files join it.
 */
async function applyPending(
  db: Db,
  schema: string,
  kind: "shared" | "tenant",
  files: readonly MigrationFile[],
  logger: Logger,
  ownTransactions: boolean,
): Promise<string[]> {
  const table = `${quoteIdentifier(schema)}.schema_migrations`;
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
  await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
    version     text        PRIMARY KEY,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`);
  const done = new Map(
    (await db.query<{ version: string; checksum: string }>(`SELECT version, checksum FROM ${table}`)).rows.map((row) => [row.version, row.checksum]),
  );
  const applied: string[] = [];
  for (const file of files) {
    const recorded = done.get(file.version);
    if (recorded !== undefined) {
      if (recorded !== file.checksum) throw new Error(`Migration ${file.version} of schema ${schema} was changed after it was applied`);
      continue;
    }
    if (ownTransactions) await db.query("BEGIN");
    try {
      let previousPath: string | null = null;
      if (kind === "tenant") {
        // The tenant files name no schema. The setting is local to the transaction and is put back afterwards, so
        // that the caller's own statements, after the files, see the search path they had.
        previousPath = (await db.query<{ path: string }>("SELECT current_setting('search_path') AS path")).rows[0]?.path ?? null;
        await db.query("SELECT set_config('search_path', $1, true)", [quoteIdentifier(schema)]);
      }
      await db.query(file.sql);
      if (previousPath !== null) await db.query("SELECT set_config('search_path', $1, true)", [previousPath]);
      await db.query(`INSERT INTO ${table} (version, checksum) VALUES ($1, $2)`, [file.version, file.checksum]);
      if (ownTransactions) await db.query("COMMIT");
    } catch (error) {
      if (ownTransactions) await db.query("ROLLBACK");
      throw error;
    }
    applied.push(file.version);
    logger.info({ migration: file.version, schema }, "Applied a migration");
  }
  return applied;
}

/**
 * Startup: applies the shared migrations, then the tenant migrations to every schema in shared.tenant_registry, all
 * under one advisory lock. Several instances may start at once; one migrates, the others wait and find nothing to do.
 */
export async function runMigrations(pool: pg.Pool, logger: Logger, directories: MigrationDirectories = MIGRATIONS_DIRS): Promise<MigrationReport> {
  const sharedFiles = await readMigrationFiles(directories.shared);
  const tenantFiles = await readMigrationFiles(directories.tenant);
  const client = await pool.connect();
  const report: MigrationReport = { shared: [], tenants: {} };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    report.shared = await applyPending(client, "shared", "shared", sharedFiles, logger, true);
    for (const schema of await listTenantSchemas(client)) {
      const applied = await applyPending(client, schema, "tenant", tenantFiles, logger, true);
      if (applied.length > 0) report.tenants[schema] = applied;
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
  return report;
}

/** The schemas of every registered tenant. */
export async function listTenantSchemas(db: Db): Promise<string[]> {
  const result = await db.query<{ schema_name: string }>("SELECT schema_name FROM shared.tenant_registry ORDER BY schema_name");
  return result.rows.map((row) => row.schema_name);
}

/**
 * Makes sure the tenant has a schema that is migrated to the latest version, and registers the tenant. Idempotent: a
 * schema that exists only gets the files it lacks. It runs inside the caller's open transaction (the TenantCreated
 * inbox stores the event id, registers the tenant and creates the schema in one transaction): the advisory lock is
 * taken for that transaction and released at its end, and if the transaction rolls back, no schema is left behind.
 */
export async function provisionTenantSchema(
  db: Db,
  tenantId: string,
  now: Date,
  logger: Logger,
  directories: MigrationDirectories = MIGRATIONS_DIRS,
): Promise<string[]> {
  const schema = tenantSchemaName(tenantId);
  const files = await readMigrationFiles(directories.tenant);
  // Shares the lock of runMigrations: a start that is migrating all schemas and a new tenant never interleave.
  await db.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
  const applied = await applyPending(db, schema, "tenant", files, logger, false);
  await db.query(
    "INSERT INTO shared.tenant_registry (tenant_id, schema_name, created_at) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO NOTHING",
    [tenantId.toLowerCase(), schema, now],
  );
  return applied;
}

/** Brings one tenant schema up to date in a transaction of its own (a repair tool and the tests; the service uses runMigrations and provisionTenantSchema). */
export async function migrateTenantSchema(
  pool: pg.Pool,
  tenantId: string,
  now: Date,
  logger: Logger,
  directories: MigrationDirectories = MIGRATIONS_DIRS,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const applied = await provisionTenantSchema(client, tenantId, now, logger, directories);
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
