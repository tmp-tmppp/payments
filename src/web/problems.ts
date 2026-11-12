import { STATUS_CODES } from "node:http";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InsufficientCredits, TradingUnavailable, Unavailable, UseCaseError } from "../usecases/errors.js";
import type { FieldError, UseCaseErrorKind } from "../usecases/errors.js";

// RFC 9457 problem details (GP-6.14). Use-case errors are mapped to HTTP here and nowhere else (GP-6.28).
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** An error that is already an HTTP answer: authentication, authorization, a missing route. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  errors?: FieldError[];
  /** Set when a withdrawal was rejected: the id of the stored withdrawal. */
  withdrawalId?: string;
}

const STATUS_BY_KIND: Record<UseCaseErrorKind, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
};

function problem(request: FastifyRequest, status: number, code: string, detail: string, errors?: FieldError[], withdrawalId?: string): Problem {
  return {
    type: `urn:chance:problem:${code.replaceAll("_", "-")}`,
    title: STATUS_CODES[status] ?? "Error",
    status,
    detail,
    instance: request.url.split("?")[0] ?? request.url,
    code,
    ...(errors ? { errors } : {}),
    ...(withdrawalId ? { withdrawalId } : {}),
  };
}

function send(reply: FastifyReply, body: Problem, headers: Record<string, string> = {}): FastifyReply {
  return reply.code(body.status).headers(headers).type(PROBLEM_CONTENT_TYPE).send(body);
}

/** Field errors of a failed JSON schema validation, named by the field the caller sent. */
function validationErrors(error: FastifyError): FieldError[] {
  return (error.validation ?? []).map((issue) => {
    const params = issue.params as { missingProperty?: string; additionalProperty?: string };
    const path = issue.instancePath.replace(/^\//, "").replaceAll("/", ".");
    const field = [path, params.missingProperty ?? params.additionalProperty].filter(Boolean).join(".");
    return { field: field || error.validationContext || "request", message: issue.message ?? "is invalid" };
  });
}

/**
 * Errors that Fastify raises before a route matches (a path parameter over the limit, a malformed URL) are problem
 * details as well, with a fixed text: the message of Fastify repeats the whole URL.
 */
export function frameworkErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  if (status === 414) {
    send(reply, problem(request, 414, "uri_too_long", "A path parameter is too long"));
  } else if (status >= 400 && status < 500) {
    send(reply, problem(request, status, "bad_request", "The request URL is invalid"));
  } else {
    send(reply, problem(request, 500, "internal_error", "The service failed to handle the request"));
  }
  // These answers bypass the hooks of the application, so the metrics are told here (src/adapters/metrics/metrics.ts).
  request.server.recordFrameworkError?.(request, reply);
}

export function registerProblemHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => send(reply, problem(request, 404, "not_found", "No such resource")));

  app.setErrorHandler((error: FastifyError | HttpError | UseCaseError, request, reply) => {
    if (error instanceof HttpError) {
      return send(reply, problem(request, error.status, error.code, error.message), error.headers);
    }
    if (error instanceof UseCaseError) {
      const status = STATUS_BY_KIND[error.kind];
      // A 503 says when to come back (plan: "503 with Retry-After").
      const headers: Record<string, string> = error instanceof Unavailable ? { "retry-after": String(error.retryAfterSeconds) } : {};
      // A rejected withdrawal is a stored resource: its answer names it and links to it.
      const rejected = error instanceof InsufficientCredits || error instanceof TradingUnavailable ? error.withdrawalId : undefined;
      if (rejected) headers["location"] = `/v1/withdrawals/${rejected}`;
      return send(reply, problem(request, status, error.code, error.message, error.fields.length ? [...error.fields] : undefined, rejected), headers);
    }
    if ("validation" in error && error.validation) {
      const errors = validationErrors(error);
      const detail = `The request is invalid: ${errors.map((issue) => `${issue.field} ${issue.message}`).join("; ")}`;
      return send(reply, problem(request, 400, "validation_failed", detail, errors));
    }
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      return send(reply, problem(request, status, "bad_request", error.message));
    }
    request.log.error({ err: error }, "Unhandled error");
    return send(reply, problem(request, 500, "internal_error", "The service failed to handle the request"));
  });
}
