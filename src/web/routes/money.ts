import type { FastifyInstance, FastifyRequest } from "fastify";
import type { UseCases } from "../../usecases/application.js";
import type { TenantCaller } from "../../usecases/support.js";
import { requireTenantUser, tenantUserHook } from "../auth.js";
import type { RequestHook } from "../auth.js";
import { depositBody, parseAmountRequest, parseIdempotencyKey, parseResourceId, schemas, withdrawalBody } from "../schemas.js";

/** The caller of a money use case. The tenant and the user come from the verified token only (plan section 9). */
function callerOf(request: FastifyRequest): TenantCaller {
  const { tenantId, userId } = requireTenantUser(request);
  return { tenantId, userId, correlationId: request.correlationId, causationId: request.id };
}

const TERMINAL_WITHDRAWAL = new Set(["paid_out", "failed", "refunded"]);

/**
 * The money API (plan 6.6): deposits and withdrawals of the trader or tenant admin that holds the token. The token is
 * verified first, then the role and the tenant; only then is the input looked at, so a caller without the role learns nothing
 * about the shape of the body. Another user's or another tenant's resource is a 404 from the use case.
 */
export function registerMoneyRoutes(app: FastifyInstance, useCases: UseCases, authenticateHook: RequestHook): void {
  const onRequest = [authenticateHook, tenantUserHook];

  app.post("/v1/deposits", { onRequest, schema: schemas.deposit }, async (request, reply) => {
    const caller = callerOf(request);
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    const amount = parseAmountRequest(request.body);
    const { deposit, created } = await useCases.createDeposit(caller, { idempotencyKey, amount });
    if (created) void reply.code(201).header("location", `/v1/deposits/${deposit.id}`);
    return depositBody(deposit);
  });

  app.get("/v1/deposits/:id", { onRequest, schema: schemas.deposit }, async (request) => {
    const caller = callerOf(request);
    const id = parseResourceId((request.params as { id?: unknown }).id);
    return depositBody(await useCases.getDeposit(caller, id));
  });

  app.post("/v1/withdrawals", { onRequest, schema: schemas.withdrawal }, async (request, reply) => {
    const caller = callerOf(request);
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    const amount = parseAmountRequest(request.body);
    const { withdrawal } = await useCases.createWithdrawal(caller, { idempotencyKey, amount });
    // Requested or debited: the saga is still going, follow the status link. A repeat of a call that has ended since answers 200.
    void reply.code(TERMINAL_WITHDRAWAL.has(withdrawal.status) ? 200 : 202).header("location", `/v1/withdrawals/${withdrawal.id}`);
    return withdrawalBody(withdrawal);
  });

  app.get("/v1/withdrawals/:id", { onRequest, schema: schemas.withdrawal }, async (request) => {
    const caller = callerOf(request);
    const id = parseResourceId((request.params as { id?: unknown }).id);
    return withdrawalBody(await useCases.getWithdrawal(caller, id));
  });
}
