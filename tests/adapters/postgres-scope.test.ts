import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { tenantSchemaName } from "../../src/adapters/postgres/migrate.js";
import { PostgresStore } from "../../src/adapters/postgres/postgres-store.js";
import { depositRepository, inboxRepository, providerEventRepository, tenantRegistryRepository, withdrawalRepository } from "../../src/adapters/postgres/postgres-repositories.js";
import { useTenantSchema } from "../../src/adapters/postgres/tenant-scope.js";
import { TenantNotReady } from "../../src/usecases/errors.js";
import { RecordingLogger, TENANT_A } from "../support/harness.js";

// The SQL itself runs against PostgreSQL in tests/integration/store.integration.test.ts. These tests check, with a fake
// connection that records every statement, that the tenant schema is chosen in one place and only after the id is checked.

interface Statement {
  sql: string;
  params: unknown[] | undefined;
}

class FakeClient {
  readonly statements: Statement[] = [];
  released = false;
  /** Tenants the registry knows (lower case). */
  registered = new Set<string>();
  /** rowCount answers for statements that start with these texts. */
  rowCounts: Array<[string, number]> = [];
  rows: unknown[] = [];

  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    this.statements.push({ sql, params });
    if (sql.startsWith("SELECT 1 FROM shared.tenant_registry")) {
      const known = this.registered.has(String(params?.[0]));
      return Promise.resolve({ rows: known ? [{ "?column?": 1 }] : [], rowCount: known ? 1 : 0 });
    }
    const override = this.rowCounts.find(([prefix]) => sql.trimStart().startsWith(prefix));
    return Promise.resolve({ rows: this.rows, rowCount: override ? override[1] : this.rows.length });
  }

  release(): void {
    this.released = true;
  }

  get sqls(): string[] {
    return this.statements.map((statement) => statement.sql.replace(/\s+/g, " ").trim());
  }
}

const asDb = (client: FakeClient) => client as unknown as Pick<pg.PoolClient, "query">;
const asPool = (client: FakeClient) => ({ connect: () => Promise.resolve(client), query: client.query.bind(client) }) as unknown as pg.Pool;

describe("useTenantSchema", () => {
  it("sets the quoted schema of a registered tenant as the search path of the transaction, in lower case", async () => {
    const client = new FakeClient();
    client.registered.add(TENANT_A);
    const schema = await useTenantSchema(asDb(client), TENANT_A.toUpperCase());
    expect(schema).toBe(tenantSchemaName(TENANT_A));
    expect(client.statements).toHaveLength(2);
    expect(client.statements[0]).toMatchObject({ params: [TENANT_A] });
    expect(client.sqls[1]).toBe("SELECT set_config('search_path', $1, true)");
    expect(client.statements[1]?.params).toEqual([`"${tenantSchemaName(TENANT_A)}"`]);
  });

  it.each(["", "acme", `${TENANT_A}; DROP SCHEMA shared`, 'x"; --', "tenant_018f3c1e7a0070008000" + "0000000000aa", `${TENANT_A}\n`])("refuses %j before any statement runs", async (value) => {
    const client = new FakeClient();
    await expect(useTenantSchema(asDb(client), value)).rejects.toThrow("A tenant id must be a UUID");
    expect(client.statements).toHaveLength(0);
  });

  it("throws TenantNotReady for a tenant without a schema and does not touch the search path", async () => {
    const client = new FakeClient();
    const error = await useTenantSchema(asDb(client), TENANT_A).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantNotReady);
    expect(error).toMatchObject({ kind: "unavailable", code: "tenant_not_ready", retryAfterSeconds: 5, tenantId: TENANT_A });
    expect(client.sqls.some((sql) => sql.includes("set_config"))).toBe(false);
  });

  it("is the only place in src that names a search path (migrate.ts does so for its own schema)", () => {
    const root = fileURLToPath(new URL("../../src", import.meta.url));
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);
    const naming = files.filter((file) => /search_path|set_config/.test(readFileSync(file, "utf8"))).map((file) => relative(root, file).replaceAll("\\", "/"));
    expect(naming.sort()).toEqual(["adapters/postgres/migrate.ts", "adapters/postgres/tenant-scope.ts"]);
  });
});

describe("PostgresStore.tenantTransaction", () => {
  it("runs BEGIN, the tenant lookup, the search path, the work and COMMIT on one connection, and releases it", async () => {
    const client = new FakeClient();
    client.registered.add(TENANT_A);
    const store = new PostgresStore(asPool(client));
    const result = await store.tenantTransaction(TENANT_A, async (r) => {
      await r.deposits.get("00000000-0000-7000-8000-000000000001", { forUpdate: true });
      await r.inbox.markProcessed("c", { id: "e", type: "t" }, new Date());
      return "done";
    });
    expect(result).toBe("done");
    expect(client.sqls[0]).toBe("BEGIN");
    expect(client.sqls[1]).toContain("shared.tenant_registry");
    expect(client.sqls[2]).toContain("set_config");
    expect(client.sqls.at(-1)).toBe("COMMIT");
    expect(client.released).toBe(true);
    // No statement of the repositories names a tenant schema; tenant tables are unqualified, shared ones are "shared.".
    const work = client.sqls.slice(3, -1);
    expect(work.some((sql) => /FROM deposits WHERE id = \$1 FOR UPDATE/.test(sql))).toBe(true);
    expect(work.some((sql) => sql.includes("INSERT INTO shared.inbox"))).toBe(true);
    expect(work.some((sql) => /tenant_[0-9a-f]{32}/.test(sql))).toBe(false);
  });

  it("rolls back and releases when the tenant is not ready or the work throws, and never commits", async () => {
    const unknown = new FakeClient();
    await expect(new PostgresStore(asPool(unknown)).tenantTransaction(TENANT_A, () => Promise.resolve(1))).rejects.toBeInstanceOf(TenantNotReady);
    expect(unknown.sqls).toContain("ROLLBACK");
    expect(unknown.sqls).not.toContain("COMMIT");
    expect(unknown.released).toBe(true);

    const failing = new FakeClient();
    failing.registered.add(TENANT_A);
    await expect(
      new PostgresStore(asPool(failing)).tenantTransaction(TENANT_A, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(failing.sqls.at(-1)).toBe("ROLLBACK");
    expect(failing.released).toBe(true);
  });

  it("refuses an id that is no UUID before it starts any statement beyond BEGIN", async () => {
    const client = new FakeClient();
    await expect(new PostgresStore(asPool(client)).tenantTransaction("'; DROP TABLE x; --", () => Promise.resolve(1))).rejects.toThrow("UUID");
    expect(client.sqls).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("provisions a tenant schema only inside a transaction", async () => {
    const client = new FakeClient();
    const store = new PostgresStore(asPool(client), new RecordingLogger());
    await expect(store.repositories.tenants.provision(TENANT_A, new Date())).rejects.toThrow("inside a transaction");
    expect(client.statements).toHaveLength(0);
  });
});

describe("the repositories", () => {
  const at = new Date("2026-11-01T10:00:00.000Z");

  it("inbox and provider events report false when the id was recorded before (no row inserted)", async () => {
    const client = new FakeClient();
    client.rowCounts = [["INSERT", 0]];
    expect(await inboxRepository(asDb(client)).markProcessed("c", { id: "e", type: "t" }, at)).toBe(false);
    expect(await providerEventRepository(asDb(client)).markReceived({ id: "evt_1", type: "payout.paid", objectId: "po_1" }, at)).toBe(false);
    client.rowCounts = [["INSERT", 1]];
    expect(await inboxRepository(asDb(client)).markProcessed("c", { id: "e", type: "t" }, at)).toBe(true);
    expect(client.sqls.every((sql) => sql.includes("ON CONFLICT"))).toBe(true);
  });

  it("an id that is no UUID names no deposit or withdrawal, and no statement is sent", async () => {
    const client = new FakeClient();
    expect(await depositRepository(asDb(client), TENANT_A).get("not-a-uuid")).toBeNull();
    expect(await withdrawalRepository(asDb(client), TENANT_A).get("1; DROP TABLE deposits")).toBeNull();
    expect(await tenantRegistryRepository(asDb(client), true, new RecordingLogger()).exists("nope")).toBe(false);
    expect(client.statements).toHaveLength(0);
  });

  it("save fails when no row was updated, and the claims lock the rows they return", async () => {
    const client = new FakeClient();
    client.rowCounts = [["UPDATE", 0]];
    const deposits = depositRepository(asDb(client), TENANT_A);
    const withdrawals = withdrawalRepository(asDb(client), TENANT_A);
    const sample = { id: "x", status: "pending" } as never;
    await expect(deposits.save(sample)).rejects.toThrow("does not exist");
    await expect(withdrawals.save(sample)).rejects.toThrow("does not exist");
    await deposits.claimDue(at, 5);
    await withdrawals.claimDebitDue(at, 5);
    await withdrawals.claimPayoutDue(at, 5);
    const claims = client.sqls.filter((sql) => sql.startsWith("SELECT"));
    expect(claims).toHaveLength(3);
    for (const sql of claims) expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claims[1]).toContain("status = 'requested' AND next_debit_at <= $1");
    expect(claims[2]).toContain("status = 'debited' AND next_payout_at <= $1");
  });

  it("fills the tenant id of the entity from the schema's tenant, not from a column", async () => {
    const client = new FakeClient();
    client.rows = [
      {
        id: "d1",
        user_id: "user-1",
        amount: 500,
        status: "pending",
        idempotency_key: "k",
        request_hash: "h",
        provider_session_id: null,
        checkout_url: null,
        failure_reason: null,
        expires_at: at,
        check_attempts: 0,
        next_check_at: at,
        last_error: null,
        created_at: at,
        updated_at: at,
        completed_at: null,
      },
    ];
    const [deposit] = await depositRepository(asDb(client), TENANT_A).claimDue(at, 1);
    expect(deposit).toMatchObject({ id: "d1", tenantId: TENANT_A, userId: "user-1", amount: 500, nextCheckAt: at });
  });
});
