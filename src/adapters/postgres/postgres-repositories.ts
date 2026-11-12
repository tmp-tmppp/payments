import type pg from "pg";
import { isUuid } from "../../domain/consumed-events.js";
import type { Deposit, DepositFailureReason, DepositStatus } from "../../domain/deposit.js";
import type { Withdrawal, WithdrawalReason, WithdrawalStatus } from "../../domain/withdrawal.js";
import type {
  DepositRepository,
  InboxRepository,
  Logger,
  ProviderEventRepository,
  TenantRegistryRepository,
  WithdrawalRepository,
} from "../../usecases/ports.js";
import { provisionTenantSchema } from "./migrate.js";

type Queryable = Pick<pg.Pool, "query">;

// Shared tables are always written with the prefix "shared."; tenant tables unqualified, under the search path that
// useTenantSchema (tenant-scope.ts) sets for the transaction. No statement here names a tenant schema.

export function inboxRepository(db: Queryable): InboxRepository {
  return {
    async markProcessed(consumer, event, at) {
      const result = await db.query(
        "INSERT INTO shared.inbox (consumer, event_id, event_type, processed_at) VALUES ($1, $2, $3, $4) ON CONFLICT (consumer, event_id) DO NOTHING",
        [consumer, event.id, event.type, at],
      );
      return result.rowCount === 1;
    },
    async purgeProcessed(olderThan) {
      const result = await db.query("DELETE FROM shared.inbox WHERE processed_at < $1", [olderThan]);
      return result.rowCount ?? 0;
    },
  };
}

export function providerEventRepository(db: Queryable): ProviderEventRepository {
  return {
    async markReceived(event, at) {
      const result = await db.query(
        "INSERT INTO shared.provider_events (event_id, event_type, object_id, received_at) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING",
        [event.id, event.type, event.objectId, at],
      );
      return result.rowCount === 1;
    },
    async purgeReceived(olderThan) {
      const result = await db.query("DELETE FROM shared.provider_events WHERE received_at < $1", [olderThan]);
      return result.rowCount ?? 0;
    },
  };
}

/**
 * `provision` needs a connection that is inside a transaction (`inTransaction`): its advisory lock and its DDL belong to
 * that transaction. Over the pool it refuses, because each statement would run on another connection.
 */
export function tenantRegistryRepository(db: Queryable, inTransaction: boolean, logger: Logger): TenantRegistryRepository {
  return {
    async list() {
      const result = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM shared.tenant_registry ORDER BY tenant_id");
      return result.rows.map((row) => row.tenant_id);
    },
    async exists(tenantId) {
      if (!isUuid(tenantId)) return false;
      const result = await db.query("SELECT 1 FROM shared.tenant_registry WHERE tenant_id = $1", [tenantId.toLowerCase()]);
      return (result.rowCount ?? 0) > 0;
    },
    async provision(tenantId, at) {
      if (!inTransaction) throw new Error("A tenant schema is provisioned inside a transaction only");
      await provisionTenantSchema(db, tenantId, at, logger);
    },
  };
}

interface DepositRow {
  id: string;
  user_id: string;
  amount: number;
  status: DepositStatus;
  idempotency_key: string;
  request_hash: string;
  provider_session_id: string | null;
  checkout_url: string | null;
  failure_reason: DepositFailureReason | null;
  expires_at: Date;
  check_attempts: number;
  next_check_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const DEPOSIT_COLUMNS =
  "id, user_id, amount, status, idempotency_key, request_hash, provider_session_id, checkout_url, failure_reason, expires_at, check_attempts, next_check_at, last_error, created_at, updated_at, completed_at";

const toDeposit = (row: DepositRow, tenantId: string): Deposit => ({
  id: row.id,
  tenantId,
  userId: row.user_id,
  amount: row.amount,
  status: row.status,
  idempotencyKey: row.idempotency_key,
  requestHash: row.request_hash,
  providerSessionId: row.provider_session_id,
  checkoutUrl: row.checkout_url,
  failureReason: row.failure_reason,
  expiresAt: row.expires_at,
  checkAttempts: row.check_attempts,
  nextCheckAt: row.next_check_at,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

/** Deposits of the tenant whose schema is the search path of the connection. The tenant id fills the entity; no column holds it. */
export function depositRepository(db: Queryable, tenantId: string): DepositRepository {
  const one = async (sql: string, params: unknown[]): Promise<Deposit | null> => {
    const result = await db.query<DepositRow>(sql, params);
    const row = result.rows[0];
    return row ? toDeposit(row, tenantId) : null;
  };
  return {
    async insert(deposit) {
      const result = await db.query(
        `INSERT INTO deposits (${DEPOSIT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
        [
          deposit.id,
          deposit.userId,
          deposit.amount,
          deposit.status,
          deposit.idempotencyKey,
          deposit.requestHash,
          deposit.providerSessionId,
          deposit.checkoutUrl,
          deposit.failureReason,
          deposit.expiresAt,
          deposit.checkAttempts,
          deposit.nextCheckAt,
          deposit.lastError,
          deposit.createdAt,
          deposit.updatedAt,
          deposit.completedAt,
        ],
      );
      return result.rowCount === 1;
    },
    get(id, options) {
      // An id that is no UUID names no row; PostgreSQL would raise an error instead of answering "none".
      if (!isUuid(id)) return Promise.resolve(null);
      return one(`SELECT ${DEPOSIT_COLUMNS} FROM deposits WHERE id = $1${options?.forUpdate ? " FOR UPDATE" : ""}`, [id]);
    },
    findByIdempotencyKey: (userId, key) => one(`SELECT ${DEPOSIT_COLUMNS} FROM deposits WHERE user_id = $1 AND idempotency_key = $2`, [userId, key]),
    async save(deposit) {
      const result = await db.query(
        `UPDATE deposits SET status = $2, provider_session_id = $3, checkout_url = $4, failure_reason = $5, check_attempts = $6,
                next_check_at = $7, last_error = $8, updated_at = $9, completed_at = $10
          WHERE id = $1`,
        [
          deposit.id,
          deposit.status,
          deposit.providerSessionId,
          deposit.checkoutUrl,
          deposit.failureReason,
          deposit.checkAttempts,
          deposit.nextCheckAt,
          deposit.lastError,
          deposit.updatedAt,
          deposit.completedAt,
        ],
      );
      if (result.rowCount !== 1) throw new Error(`The deposit ${deposit.id} does not exist`);
    },
    async claimDue(now, limit) {
      const result = await db.query<DepositRow>(
        `SELECT ${DEPOSIT_COLUMNS} FROM deposits WHERE status = 'pending' AND next_check_at <= $1
          ORDER BY next_check_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      return result.rows.map((row) => toDeposit(row, tenantId));
    },
  };
}

interface WithdrawalRow {
  id: string;
  user_id: string;
  amount: number;
  status: WithdrawalStatus;
  idempotency_key: string;
  request_hash: string;
  reason: WithdrawalReason | null;
  provider_payout_id: string | null;
  debit_attempts: number;
  next_debit_at: Date | null;
  payout_attempts: number;
  next_payout_at: Date | null;
  payout_requested_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const WITHDRAWAL_COLUMNS =
  "id, user_id, amount, status, idempotency_key, request_hash, reason, provider_payout_id, debit_attempts, next_debit_at, payout_attempts, next_payout_at, payout_requested_at, last_error, created_at, updated_at, completed_at";

const toWithdrawal = (row: WithdrawalRow, tenantId: string): Withdrawal => ({
  id: row.id,
  tenantId,
  userId: row.user_id,
  amount: row.amount,
  status: row.status,
  idempotencyKey: row.idempotency_key,
  requestHash: row.request_hash,
  reason: row.reason,
  providerPayoutId: row.provider_payout_id,
  debitAttempts: row.debit_attempts,
  nextDebitAt: row.next_debit_at,
  payoutAttempts: row.payout_attempts,
  nextPayoutAt: row.next_payout_at,
  payoutRequestedAt: row.payout_requested_at,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

/** Withdrawals of the tenant whose schema is the search path of the connection. */
export function withdrawalRepository(db: Queryable, tenantId: string): WithdrawalRepository {
  const one = async (sql: string, params: unknown[]): Promise<Withdrawal | null> => {
    const result = await db.query<WithdrawalRow>(sql, params);
    const row = result.rows[0];
    return row ? toWithdrawal(row, tenantId) : null;
  };
  const claim = async (due: "next_debit_at" | "next_payout_at", status: "requested" | "debited", now: Date, limit: number): Promise<Withdrawal[]> => {
    const result = await db.query<WithdrawalRow>(
      `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals WHERE status = '${status}' AND ${due} <= $1
        ORDER BY ${due}, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return result.rows.map((row) => toWithdrawal(row, tenantId));
  };
  return {
    async insert(withdrawal) {
      const result = await db.query(
        `INSERT INTO withdrawals (${WITHDRAWAL_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
        [
          withdrawal.id,
          withdrawal.userId,
          withdrawal.amount,
          withdrawal.status,
          withdrawal.idempotencyKey,
          withdrawal.requestHash,
          withdrawal.reason,
          withdrawal.providerPayoutId,
          withdrawal.debitAttempts,
          withdrawal.nextDebitAt,
          withdrawal.payoutAttempts,
          withdrawal.nextPayoutAt,
          withdrawal.payoutRequestedAt,
          withdrawal.lastError,
          withdrawal.createdAt,
          withdrawal.updatedAt,
          withdrawal.completedAt,
        ],
      );
      return result.rowCount === 1;
    },
    get(id, options) {
      if (!isUuid(id)) return Promise.resolve(null);
      return one(`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals WHERE id = $1${options?.forUpdate ? " FOR UPDATE" : ""}`, [id]);
    },
    findByIdempotencyKey: (userId, key) => one(`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawals WHERE user_id = $1 AND idempotency_key = $2`, [userId, key]),
    async save(withdrawal) {
      const result = await db.query(
        `UPDATE withdrawals SET status = $2, reason = $3, provider_payout_id = $4, debit_attempts = $5, next_debit_at = $6,
                payout_attempts = $7, next_payout_at = $8, payout_requested_at = $9, last_error = $10, updated_at = $11, completed_at = $12
          WHERE id = $1`,
        [
          withdrawal.id,
          withdrawal.status,
          withdrawal.reason,
          withdrawal.providerPayoutId,
          withdrawal.debitAttempts,
          withdrawal.nextDebitAt,
          withdrawal.payoutAttempts,
          withdrawal.nextPayoutAt,
          withdrawal.payoutRequestedAt,
          withdrawal.lastError,
          withdrawal.updatedAt,
          withdrawal.completedAt,
        ],
      );
      if (result.rowCount !== 1) throw new Error(`The withdrawal ${withdrawal.id} does not exist`);
    },
    claimDebitDue: (now, limit) => claim("next_debit_at", "requested", now, limit),
    claimPayoutDue: (now, limit) => claim("next_payout_at", "debited", now, limit),
  };
}
