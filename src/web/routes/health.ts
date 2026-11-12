import type { FastifyInstance } from "fastify";
import { HttpError } from "../problems.js";
import { schemas } from "../schemas.js";

export interface HealthChecks {
  /** Resolves when the service's own database answers; rejects otherwise. */
  ping(): Promise<void>;
  /** True from the moment the process got SIGTERM: readiness then answers 503 while requests in flight finish. */
  isDraining(): boolean;
}

/** Kubernetes probes (REL-05). No token needed; the gateway does not route them. */
export function registerHealthRoutes(app: FastifyInstance, checks: HealthChecks): void {
  // Probes run every few seconds: log only their problems.
  const options = { schema: schemas.health, logLevel: "warn" } as const;

  // Answers once the service listens: migrations ran before the server started.
  app.get("/health/startup", options, () => ({ status: "up" }));

  // Ready = the own database answers. Nothing else is checked: a dependency's outage must not stop this pod.
  // Not ready at all once the process is shutting down, so that the load balancer stops sending new requests
  // before the server closes (the drain delay of main.ts).
  app.get("/health/ready", options, async (request) => {
    if (checks.isDraining()) throw new HttpError(503, "shutting_down", "The service is shutting down");
    try {
      await checks.ping();
    } catch (error) {
      request.log.warn({ err: error }, "The database does not answer");
      throw new HttpError(503, "not_ready", "The database does not answer");
    }
    return { status: "up" };
  });

  // Live = the process runs and the event loop answers. It never touches the database (a database outage
  // must not restart the pod).
  app.get("/health/live", options, () => ({ status: "up" }));
}
