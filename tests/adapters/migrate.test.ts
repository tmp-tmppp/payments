import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIRS, provisionTenantSchema, readMigrationFiles, tenantSchemaName } from "../../src/adapters/postgres/migrate.js";
import { RecordingLogger, TENANT_A } from "../support/harness.js";

// The SQL itself runs against PostgreSQL in tests/integration/migrations.integration.test.ts. These tests check what the
// runner does around it, with a fake connection that records every statement.
class FakeDb {
  readonly statements: Array<{ sql: string; params: unknown[] | undefined }> = [];
  readonly recorded = new Map<string, Map<string, string>>();

  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    this.statements.push({ sql, params });
    const table = /"([^"]+)"\.schema_migrations/.exec(sql)?.[1] ?? "";
    if (sql.startsWith("SELECT version, checksum FROM")) {
      return Promise.resolve({ rows: [...(this.recorded.get(table) ?? new Map()).entries()].map(([version, checksum]) => ({ version, checksum })) });
    }
    if (sql.startsWith("INSERT INTO") && sql.includes("schema_migrations")) {
      const map = this.recorded.get(table) ?? new Map<string, string>();
      map.set(String(params?.[0]), String(params?.[1]));
      this.recorded.set(table, map);
    }
    if (sql.startsWith("SELECT current_setting('search_path')")) return Promise.resolve({ rows: [{ path: '"$user", public' }] });
    return Promise.resolve({ rows: [] });
  }

  get sqls(): string[] {
    return this.statements.map((statement) => statement.sql);
  }
}

const asDb = (db: FakeDb) => db as unknown as Pick<pg.PoolClient, "query">;
const NOW = new Date("2026-11-01T10:00:00.000Z");

describe("tenantSchemaName", () => {
  it("is tenant_ and the 32 hex digits of the id, in lower case", () => {
    expect(tenantSchemaName(TENANT_A)).toBe("tenant_018f3c1e7a0070008000" + "0000000000aa");
    expect(tenantSchemaName(TENANT_A.toUpperCase())).toBe(tenantSchemaName(TENANT_A));
  });

  it.each(["", "acme", "tenant_x", "018f3c1e-7a00-7000-8000-0000000000a", `${TENANT_A}; DROP SCHEMA shared`, 'x"; --'])("refuses %j", (value) => {
    expect(() => tenantSchemaName(value)).toThrow("A tenant id must be a UUID");
  });
});

describe("readMigrationFiles", () => {
  it("reads the shared and the tenant folder of the service, in order, with a checksum", async () => {
    const shared = await readMigrationFiles(MIGRATIONS_DIRS.shared);
    const tenant = await readMigrationFiles(MIGRATIONS_DIRS.tenant);
    expect(shared.map((file) => file.version)).toEqual(["001_init.sql"]);
    expect(tenant.map((file) => file.version)).toEqual(["001_init.sql"]);
    expect(shared[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(shared[0]?.sql).toContain("shared.outbox");
    expect(tenant[0]?.sql).toContain("CREATE TABLE deposits");
  });

  describe("in a folder of its own", () => {
    let directory: string;
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "payments-migrations-"));
      await writeFile(join(directory, "010_later.sql"), "SELECT 10;");
      await writeFile(join(directory, "002_second.sql"), "SELECT 2;");
      await writeFile(join(directory, "001_first.sql"), "SELECT 1;");
      await writeFile(join(directory, "notes.txt"), "not a migration");
      await writeFile(join(directory, "3_short.sql"), "SELECT 3;");
      await writeFile(join(directory, "004_Upper.sql"), "SELECT 4;");
    });
    afterAll(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("takes only the files NNN_name.sql and sorts them by number", async () => {
      const files = await readMigrationFiles(pathToFileURL(`${directory}/`));
      expect(files.map((file) => file.version)).toEqual(["001_first.sql", "002_second.sql", "010_later.sql"]);
    });

    it("gives a different checksum to a different text", async () => {
      const files = await readMigrationFiles(pathToFileURL(`${directory}/`));
      expect(new Set(files.map((file) => file.checksum)).size).toBe(3);
    });
  });
});

describe("provisionTenantSchema", () => {
  it("takes the lock first, creates the schema, applies the files with the schema as search path, restores the path and registers the tenant", async () => {
    const db = new FakeDb();
    const applied = await provisionTenantSchema(asDb(db), TENANT_A.toUpperCase(), NOW, new RecordingLogger());
    const schema = tenantSchemaName(TENANT_A);

    expect(applied).toEqual(["001_init.sql"]);
    expect(db.statements[0]).toEqual({ sql: "SELECT pg_advisory_xact_lock($1)", params: [726_001] });
    expect(db.sqls[1]).toBe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    const searchPath = db.statements.filter((statement) => statement.sql.startsWith("SELECT set_config('search_path'"));
    expect(searchPath.map((statement) => statement.params)).toEqual([[`"${schema}"`], ['"$user", public']]);
    const create = db.sqls.findIndex((sql) => sql.includes("CREATE TABLE deposits"));
    expect(db.sqls.indexOf(searchPath[0]?.sql ?? "")).toBeLessThan(create);
    expect(db.statements.at(-1)?.sql).toContain("INSERT INTO shared.tenant_registry");
    expect(db.statements.at(-1)?.params).toEqual([TENANT_A, schema, NOW]);
    // The caller owns the transaction.
    expect(db.sqls).not.toContain("BEGIN");
    expect(db.sqls).not.toContain("COMMIT");
  });

  it("applies nothing to a schema that has every file, and registers the tenant again harmlessly", async () => {
    const db = new FakeDb();
    await provisionTenantSchema(asDb(db), TENANT_A, NOW, new RecordingLogger());
    const before = db.statements.length;

    expect(await provisionTenantSchema(asDb(db), TENANT_A, NOW, new RecordingLogger())).toEqual([]);
    expect(db.statements.slice(before).some((statement) => statement.sql.includes("CREATE TABLE deposits"))).toBe(false);
    expect(db.statements.at(-1)?.sql).toContain("ON CONFLICT (tenant_id) DO NOTHING");
  });

  it("stops when a file was changed after it was applied", async () => {
    const db = new FakeDb();
    db.recorded.set(tenantSchemaName(TENANT_A), new Map([["001_init.sql", "0".repeat(64)]]));
    await expect(provisionTenantSchema(asDb(db), TENANT_A, NOW, new RecordingLogger())).rejects.toThrow(
      /Migration 001_init\.sql of schema tenant_[0-9a-f]{32} was changed after it was applied/,
    );
    expect(db.sqls.some((sql) => sql.includes("CREATE TABLE deposits"))).toBe(false);
  });

  it("refuses an id that is no UUID before it sends a statement", async () => {
    const db = new FakeDb();
    await expect(provisionTenantSchema(asDb(db), "acme", NOW, new RecordingLogger())).rejects.toThrow("A tenant id must be a UUID");
    expect(db.statements).toEqual([]);
  });

  it("logs each applied file with its schema", async () => {
    const logger = new RecordingLogger();
    await provisionTenantSchema(asDb(new FakeDb()), TENANT_A, NOW, logger);
    expect(logger.lines).toEqual([{ level: "info", fields: { migration: "001_init.sql", schema: tenantSchemaName(TENANT_A) }, message: "Applied a migration" }]);
  });
});
