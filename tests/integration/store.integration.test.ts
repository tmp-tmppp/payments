import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, tenantSchemaName } from "../../src/adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "../../src/adapters/postgres/postgres-store.js";
import { newDeposit, succeedDeposit } from "../../src/domain/deposit.js";
import { attachPayout, markDebited, markPaidOut, newWithdrawal } from "../../src/domain/withdrawal.js";
import { TenantNotReady } from "../../src/usecases/errors.js";
import { RecordingLogger, TENANT_A, TENANT_B } from "../support/harness.js";

// Needs a running Docker daemon: "npm run test:integration". The repositories run their real SQL against PostgreSQL 18.

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let store: PostgresStore;
const logger = new RecordingLogger();
const NOW = new Date("2026-11-01T10:00:00.000Z");
const later = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
const ID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const deposit = (n: number, tenantId = TENANT_A, userId = "user-1", key = `key-${n}`, now = NOW) =>
  newDeposit({ id: ID(n), tenantId, userId, amount: 500, idempotencyKey: key, requestHash: "hash", now });
const withdrawal = (n: number, tenantId = TENANT_A, userId = "user-1", key = `key-${n}`, now = NOW) =>
  newWithdrawal({ id: ID(n), tenantId, userId, amount: 300, idempotencyKey: key, requestHash: "hash", now });

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18").withDatabase("payments").start();
  pool = createPool(container.getConnectionUri(), 8);
  store = new PostgresStore(pool, logger);
  await runMigrations(pool, logger);
  for (const tenant of [TENANT_A, TENANT_B]) await store.transaction((r) => r.tenants.provision(tenant, NOW));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const schemaExists = async (name: string): Promise<boolean> =>
  ((await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [name])).rowCount ?? 0) > 0;

describe("tenant schemas", () => {
  it("the registry lists the provisioned tenants, and an unknown or malformed id is refused before any row is touched", async () => {
    expect(await store.repositories.tenants.list()).toEqual([TENANT_A, TENANT_B]);
    expect(await store.repositories.tenants.exists(TENANT_A)).toBe(true);
    await expect(store.tenantTransaction("018f3c1e-7a00-7000-8000-0000000000cc", () => Promise.resolve(1))).rejects.toBeInstanceOf(TenantNotReady);
    await expect(store.tenantTransaction("x'; DROP SCHEMA shared; --", () => Promise.resolve(1))).rejects.toThrow("UUID");
    expect(await schemaExists("shared")).toBe(true);
  });

  it("the search path is local to the transaction: the connection is clean afterwards", async () => {
    await store.tenantTransaction(TENANT_A, () => Promise.resolve(undefined));
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ search_path: string }>("SHOW search_path");
      expect(rows[0]?.search_path).not.toContain("tenant_");
    } finally {
      client.release();
    }
  });

  it("provision is idempotent, and a transaction that fails leaves no schema, no registry row and no inbox record", async () => {
    const tenant = "018f3c1e-7a00-7000-8000-0000000000dd";
    await expect(
      store.transaction(async (r) => {
        expect(await r.inbox.markProcessed("tenant-created", { id: "evt-rollback", type: "t" }, NOW)).toBe(true);
        await r.tenants.provision(tenant, NOW);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await schemaExists(tenantSchemaName(tenant))).toBe(false);
    expect(await store.repositories.tenants.exists(tenant)).toBe(false);
    expect(await store.repositories.inbox.markProcessed("tenant-created", { id: "evt-rollback", type: "t" }, NOW)).toBe(true);

    const handle = (eventId: string) =>
      store.transaction(async (r) => {
        if (!(await r.inbox.markProcessed("tenant-created", { id: eventId, type: "t" }, NOW))) return "duplicate";
        await r.tenants.provision(tenant, NOW);
        return "processed";
      });
    expect(await handle("evt-ok")).toBe("processed");
    expect(await handle("evt-ok")).toBe("duplicate");
    await store.transaction((r) => r.tenants.provision(tenant, NOW));
    expect(await schemaExists(tenantSchemaName(tenant))).toBe(true);
    expect(await store.tenantTransaction(tenant, (r) => r.deposits.get(ID(1)))).toBeNull();
  });
});

describe("inbox and provider events", () => {
  it("record an id once, purge old ones", async () => {
    const inbox = store.repositories.inbox;
    expect(await inbox.markProcessed("c1", { id: "e1", type: "t" }, NOW)).toBe(true);
    expect(await inbox.markProcessed("c1", { id: "e1", type: "t" }, NOW)).toBe(false);
    expect(await inbox.markProcessed("c2", { id: "e1", type: "t" }, later(10))).toBe(true);
    expect(await inbox.purgeProcessed(later(5))).toBeGreaterThanOrEqual(1);
    const events = store.repositories.providerEvents;
    expect(await events.markReceived({ id: "evt_1", type: "payout.paid", objectId: "po_1" }, NOW)).toBe(true);
    expect(await events.markReceived({ id: "evt_1", type: "payout.paid", objectId: "po_1" }, NOW)).toBe(false);
    expect(await events.purgeReceived(later(1))).toBe(1);
  });

  it("the provider event id is stored in the same transaction as the change: a rollback forgets both", async () => {
    await expect(
      store.tenantTransaction(TENANT_A, async (r) => {
        await r.deposits.insert(deposit(50));
        expect(await r.providerEvents.markReceived({ id: "evt_tx", type: "checkout.session.completed", objectId: "cs_1" }, NOW)).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.tenantTransaction(TENANT_A, (r) => r.deposits.get(ID(50)))).toBeNull();
    expect(await store.repositories.providerEvents.markReceived({ id: "evt_tx", type: "x", objectId: "cs_1" }, NOW)).toBe(true);
  });
});

describe("deposits", () => {
  it("round-trips every field, fills the tenant id, and answers the same key with false", async () => {
    const created = deposit(1);
    await store.tenantTransaction(TENANT_A, async (r) => {
      expect(await r.deposits.insert(created)).toBe(true);
      expect(await r.deposits.insert({ ...deposit(2, TENANT_A, "user-1", "key-1") })).toBe(false);
      expect(await r.deposits.get(ID(1))).toEqual(created);
      expect(await r.deposits.findByIdempotencyKey("user-1", "key-1")).toEqual(created);
      expect(await r.deposits.get(ID(2))).toBeNull();
      expect(await r.deposits.get("not-a-uuid")).toBeNull();
      expect(await r.deposits.findByIdempotencyKey("user-2", "key-1")).toBeNull();
    });
  });

  it("saves status changes and the checkout session, within the table's constraints", async () => {
    await store.tenantTransaction(TENANT_A, async (r) => {
      const stored = await r.deposits.get(ID(1), { forUpdate: true });
      const done = succeedDeposit({ ...(stored as NonNullable<typeof stored>), providerSessionId: "cs_1", checkoutUrl: "http://provider.example/checkout/cs_1" }, later(3));
      await r.deposits.save(done);
      expect(await r.deposits.get(ID(1))).toEqual(done);
      await expect(r.deposits.save(deposit(99))).rejects.toThrow("does not exist");
    });
  });

  it("keeps tenants apart: the same id and the same key exist once per tenant schema", async () => {
    await store.tenantTransaction(TENANT_B, async (r) => {
      expect(await r.deposits.get(ID(1))).toBeNull();
      expect(await r.deposits.insert(deposit(1, TENANT_B))).toBe(true);
      expect((await r.deposits.get(ID(1)))?.tenantId).toBe(TENANT_B);
      expect((await r.deposits.get(ID(1)))?.status).toBe("pending");
    });
    expect((await store.tenantTransaction(TENANT_A, (r) => r.deposits.get(ID(1))))?.status).toBe("succeeded");
  });

  it("claims the due pending deposits oldest first, and a second transaction skips the rows the first one holds", async () => {
    await store.tenantTransaction(TENANT_A, async (r) => {
      await r.deposits.insert(deposit(11, TENANT_A, "u", "k11", later(10)));
      await r.deposits.insert(deposit(12, TENANT_A, "u", "k12", NOW));
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed: string[] = [];
    const first = store.tenantTransaction(TENANT_A, async (r) => {
      claimed = (await r.deposits.claimDue(later(60), 10)).map((row) => row.id);
      await held;
    });
    // Wait until the first transaction holds its rows, then look from a second one.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const skipped = await store.tenantTransaction(TENANT_A, async (r) => (await r.deposits.claimDue(later(60), 10)).map((row) => row.id));
    release();
    await first;
    expect(claimed).toEqual([ID(12), ID(11)]);
    expect(skipped).toEqual([]);
    expect(await store.tenantTransaction(TENANT_A, async (r) => (await r.deposits.claimDue(later(29), 10)).map((row) => row.id))).toEqual([]);
  });
});

describe("withdrawals", () => {
  it("follows the saga through the table's constraints and round-trips", async () => {
    await store.tenantTransaction(TENANT_A, async (r) => {
      const created = withdrawal(1);
      expect(await r.withdrawals.insert(created)).toBe(true);
      expect(await r.withdrawals.insert(withdrawal(2, TENANT_A, "user-1", "key-1"))).toBe(false);
      expect(await r.withdrawals.get(ID(1))).toEqual(created);
      expect(await r.withdrawals.findByIdempotencyKey("user-1", "key-1")).toEqual(created);
      expect((await r.withdrawals.claimDebitDue(later(1), 10)).map((row) => row.id)).toEqual([ID(1)]);

      const debited = markDebited(created, later(1));
      await r.withdrawals.save(debited);
      expect(await r.withdrawals.claimDebitDue(later(1), 10)).toEqual([]);
      expect((await r.withdrawals.claimPayoutDue(later(1), 10)).map((row) => row.id)).toEqual([ID(1)]);

      const withPayout = attachPayout(debited, "po_1", later(2));
      await r.withdrawals.save(withPayout);
      const paid = markPaidOut(withPayout, later(3));
      await r.withdrawals.save(paid);
      expect(await r.withdrawals.get(ID(1))).toEqual(paid);
      expect(await r.withdrawals.claimPayoutDue(later(60), 10)).toEqual([]);
      await expect(r.withdrawals.save(withdrawal(99))).rejects.toThrow("does not exist");
    });
  });

  it("a debit in the same transaction as its outbox event commits or rolls back together", async () => {
    const failed = withdrawal(20, TENANT_A, "user-9", "k20");
    await expect(
      store.tenantTransaction(TENANT_A, async (r) => {
        await r.withdrawals.insert(failed);
        await r.outbox.add({ id: ID(900), aggregateId: ID(20), subject: `chance.payments.WithdrawalFailed.${TENANT_A}`, type: "t", payload: {} as never, createdAt: NOW });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.tenantTransaction(TENANT_A, (r) => r.withdrawals.get(ID(20)))).toBeNull();
    expect((await pool.query("SELECT 1 FROM shared.outbox WHERE id = $1", [ID(900)])).rowCount).toBe(0);
    await store.tenantTransaction(TENANT_A, async (r) => {
      await r.withdrawals.insert(failed);
      await r.outbox.add({ id: ID(900), aggregateId: ID(20), subject: `chance.payments.WithdrawalFailed.${TENANT_A}`, type: "t", payload: {} as never, createdAt: NOW });
    });
    expect((await pool.query("SELECT 1 FROM shared.outbox WHERE id = $1", [ID(900)])).rowCount).toBe(1);
  });

  it("concurrent transactions of two tenants never see each other's rows (the search path does not leak through pooled connections)", async () => {
    const work = [] as Array<Promise<void>>;
    for (let n = 0; n < 12; n += 1) {
      const tenant = n % 2 === 0 ? TENANT_A : TENANT_B;
      work.push(
        store.tenantTransaction(tenant, async (r) => {
          expect(await r.withdrawals.insert(withdrawal(100 + n, tenant, `user-${tenant === TENANT_A ? "a" : "b"}`, `kc${n}`))).toBe(true);
        }),
      );
    }
    await Promise.all(work);
    const countOf = (tenant: string, user: string) =>
      store.tenantTransaction(tenant, async (r) => [(await r.withdrawals.findByIdempotencyKey(user, "kc0")) !== null, (await r.withdrawals.findByIdempotencyKey(user, "kc1")) !== null]);
    expect(await countOf(TENANT_A, "user-a")).toEqual([true, false]);
    expect(await countOf(TENANT_B, "user-b")).toEqual([false, true]);
    expect(await countOf(TENANT_A, "user-b")).toEqual([false, false]);
  });
});
