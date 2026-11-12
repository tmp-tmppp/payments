// Metrics of the service: rate, errors and duration of the HTTP API (REQ-20). One file, the same in every service of
// the platform; the service-specific part is the one `tenantOf` function that the composition root passes in.
//
// The metrics convention (agreed 2026-11-11; the Prometheus chart scrapes exactly this):
//   - prom-client 15.x, its default metrics (collectDefaultMetrics) on a registry of the service.
//   - http_requests_total (Counter) and http_request_duration_seconds (Histogram, default buckets), both with the
//     labels {method, route, status_code, tenant}.
//   - route is the Fastify route template (request.routeOptions.url), or "unmatched" when no route matched (404s), so
//     raw URLs and ids never become label values.
//   - tenant is the tenant id the request's verified token names (the service's own auth result), else "none". Never
//     a value taken from an unverified header or the body.
//   - GET /metrics is served on a listener of its own, on METRICS_PORT (default 9464). The API port never serves
//     /metrics, so the gateway can never route it. The listener closes with the service on shutdown.
//   - An answer that Fastify gives before a route matches (a malformed percent-encoding in the URL, a path parameter
//     over the limit) goes through the frameworkErrors handler on a request that carries none of the application's
//     hooks. attach() decorates the application with recordFrameworkError, which that handler calls after it sent its
//     answer: the answer is counted as route "unmatched" and tenant "none" (no route matched, no token was verified).
//   - The chart: container port "metrics", pod annotations prometheus.io/{scrape,port,path}, a NetworkPolicy rule
//     for the monitoring namespace on that port.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Counts an answer of Fastify's frameworkErrors handler, which runs on a request without the application's hooks.
     * Set by Metrics.attach; absent on an application that records no metrics. Call it after the answer was sent.
     */
    recordFrameworkError?: (request: FastifyRequest, reply: FastifyReply) => void;
  }
}

export const METRICS_PATH = "/metrics";
/** The label value of a request that matched no route, and of a request without a verified tenant. */
export const UNMATCHED_ROUTE = "unmatched";
export const NO_TENANT = "none";

export interface MetricsOptions {
  /**
   * The tenant id the verified token of the request names, or null/undefined when the request has no verified token
   * (or the token names no tenant). It must read the service's own auth result only, never a header or the body.
   */
  tenantOf: (request: FastifyRequest) => string | null | undefined;
}

export interface Metrics {
  registry: Registry;
  /** Registers the recording hook and the recorder of Fastify's own framework errors. Call it before the routes are registered. */
  attach(app: FastifyInstance): void;
}

export interface MetricsServer {
  /** The port the listener is bound to (the real one when it was started with 0). */
  port: number;
  /** Stops accepting connections and resolves when the listener is closed. */
  close(): Promise<void>;
}

export interface MetricsServerOptions {
  port: number;
  /** Default "0.0.0.0": the Pod's address is what Prometheus scrapes. */
  host?: string;
}

const LABELS = ["method", "route", "status_code", "tenant"] as const;

/** A registry with the default process metrics, the two HTTP metrics, and the hook that records them. */
export function createMetrics(options: MetricsOptions): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const requests = new Counter({
    name: "http_requests_total",
    help: "HTTP requests handled, by method, route template, status code and tenant.",
    labelNames: LABELS,
    registers: [registry],
  });
  const duration = new Histogram({
    name: "http_request_duration_seconds",
    help: "Time from the arrival of an HTTP request to the end of its response, in seconds.",
    labelNames: LABELS,
    registers: [registry],
  });

  const tenantOf = (request: FastifyRequest): string => {
    try {
      const tenant = options.tenantOf(request);
      return typeof tenant === "string" && tenant.length > 0 ? tenant : NO_TENANT;
    } catch {
      return NO_TENANT;
    }
  };

  const observe = (request: FastifyRequest, reply: FastifyReply, route: string, tenant: string): void => {
    const labels = { method: request.method, route, status_code: String(reply.statusCode), tenant };
    requests.inc(labels);
    // elapsedTime counts from the start of the request, in milliseconds (0 for an answer given before a route matched).
    duration.observe(labels, reply.elapsedTime / 1000);
  };

  const record = (request: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    // request.is404: the not-found handler answered; any other 404 came from a matched route and keeps its template.
    const template = request.is404 ? undefined : request.routeOptions.url;
    observe(request, reply, template ?? UNMATCHED_ROUTE, tenantOf(request));
    done();
  };

  return {
    registry,
    attach: (app) => {
      app.addHook("onResponse", record);
      // No hook ran for the request of a framework error: no route matched and no token was verified.
      app.decorate("recordFrameworkError", (request: FastifyRequest, reply: FastifyReply) => observe(request, reply, UNMATCHED_ROUTE, NO_TENANT));
    },
  };
}

function handle(registry: Registry, request: IncomingMessage, response: ServerResponse): void {
  let path: string;
  try {
    path = new URL(request.url ?? "/", "http://metrics.invalid").pathname;
  } catch {
    path = "";
  }
  if (path !== METRICS_PATH) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found\n");
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { allow: "GET", "content-type": "text/plain; charset=utf-8" }).end("Method not allowed\n");
    return;
  }
  registry.metrics().then(
    (body) => {
      response.writeHead(200, { "content-type": registry.contentType }).end(body);
    },
    () => {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("Could not collect the metrics\n");
    },
  );
}

/** Starts the separate listener that serves GET /metrics (any other path answers 404). */
export function startMetricsServer(registry: Registry, options: MetricsServerOptions): Promise<MetricsServer> {
  const server: Server = createServer((request, response) => handle(registry, request, response));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: options.port, host: options.host ?? "0.0.0.0" }, () => {
      server.off("error", reject);
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done, fail) => {
            // A scraper keeps its connection open between scrapes: the idle ones are dropped at once, a scrape in
            // flight finishes, and whatever is still open after a second is cut.
            const cut = setTimeout(() => server.closeAllConnections(), 1000);
            cut.unref();
            server.close((error) => {
              clearTimeout(cut);
              if (error) fail(error);
              else done();
            });
            server.closeIdleConnections();
          }),
      });
    });
  });
}
