import type pg from "pg";
import { TenantNotReady } from "../../usecases/errors.js";
import { quoteIdentifier, tenantSchemaName } from "./migrate.js";

type Db = Pick<pg.PoolClient, "query">;

/**
 * THE function that chooses a tenant's schema for requests, consumers and jobs (migrations name their own schema in
 * migrate.ts). Call it first inside the transaction of the work: it
 *   1. validates the id as a UUID (tenantSchemaName throws before any statement runs, so a crafted value never reaches SQL),
 *   2. looks the tenant up in shared.tenant_registry and throws TenantNotReady when it has no schema yet,
 *   3. sets the search path of this transaction (set_config(..., true) ends with the transaction) to the quoted schema
 *      name and nothing else. The tenant tables are then written unqualified, the shared tables with the prefix "shared.".
 * An identifier cannot be a bind parameter, so the name is quoted instead; it is also derived from the validated UUID
 * only, and the registry's CHECK constraints require the same shape.
 */
export async function useTenantSchema(db: Db, tenantId: string): Promise<string> {
  const schema = tenantSchemaName(tenantId);
  const registered = await db.query("SELECT 1 FROM shared.tenant_registry WHERE tenant_id = $1", [tenantId.toLowerCase()]);
  if ((registered.rowCount ?? registered.rows.length) === 0) throw new TenantNotReady(tenantId.toLowerCase());
  await db.query("SELECT set_config('search_path', $1, true)", [quoteIdentifier(schema)]);
  return schema;
}
