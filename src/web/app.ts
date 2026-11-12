import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Logger as PinoLogger } from "pino";
import { v7 as uuidv7 } from "uuid";
import type { UseCases } from "../usecases/application.js";
import { authenticate } from "./auth.js";
import type { AuthOptions } from "./auth.js";
import { frameworkErrorHandler, registerProblemHandlers } from "./problems.js";
import { registerHealthRoutes } from "./routes/health.js";
import type { HealthChecks } from "./routes/health.js";
import { registerMoneyRoutes } from "./routes/money.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import type { WebhookOptions } from "./routes/webhooks.js";

export interface WebDeps {
  logger: PinoLogger;
  auth: AuthOptions;
  health: HealthChecks;
  useCases: UseCases;
  webhook: WebhookOptions;
  /** Records the request metrics (src/adapters/metrics/metrics.ts); optional, most tests leave it out. */
  metrics?: { attach(app: FastifyInstance): void };
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Every route that was registered, for the contract tests. */
    registeredRoutes: RegisteredRoute[];
  }
}

// Letters, digits and a few separators, so a client cannot inject anything odd into logs and headers.
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Builds the Fastify application (not started): tests call it with app.inject. */
export function buildApp(deps: WebDeps): FastifyInstance {
  const logger: FastifyBaseLogger = deps.logger;
  const app: FastifyInstance = Fastify({
    loggerInstance: logger,
    genReqId: () => uuidv7(),
    exposeHeadRoutes: false,
    bodyLimit: 16 * 1024,
    frameworkErrors: frameworkErrorHandler,
    ajv: { customOptions: { allErrors: true, removeAdditional: false, coerceTypes: "array" } },
  });

  const registeredRoutes: RegisteredRoute[] = [];
  app.decorate("registeredRoutes", registeredRoutes);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) registeredRoutes.push({ method, url: route.url });
  });

  app.decorateRequest("auth", null);
  app.decorateRequest("correlationId", "");

  // Correlation: take X-Correlation-Id from the caller or make one, return it and bind it to the request logger.
  app.addHook("onRequest", (request, reply, done) => {
    const sent = request.headers["x-correlation-id"];
    request.correlationId = typeof sent === "string" && CORRELATION_ID.test(sent) ? sent : uuidv7();
    reply.header("x-correlation-id", request.correlationId);
    request.log = reply.log = request.log.child({ correlationId: request.correlationId });
    done();
  });

  // Before the routes, so that every response is counted, also the 404 of a path that matches no route.
  deps.metrics?.attach(app);

  registerProblemHandlers(app);

  // The money API verifies the bearer token (authenticate) and then the role and the tenant; the webhook has no token and
  // checks the provider's signature instead; the probes need neither.
  registerMoneyRoutes(app, deps.useCases, authenticate(deps.auth));
  registerWebhookRoutes(app, deps.useCases, deps.webhook);
  registerHealthRoutes(app, deps.health);

  return app;
}
