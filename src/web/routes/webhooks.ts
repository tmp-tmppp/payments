import type { FastifyInstance } from "fastify";
import { verifyWebhookSignature } from "../../domain/webhook-signature.js";
import type { UseCases } from "../../usecases/application.js";
import { HttpError } from "../problems.js";
import { parseProviderEvent, schemas } from "../schemas.js";

export interface WebhookOptions {
  /** The secret that signs the provider's webhooks. Null (a local run without a provider): every webhook is refused. */
  secret: string | null;
  /** The current time in whole seconds since 1970 (UTC). */
  nowSeconds: () => number;
}

/**
 * POST /v1/webhooks/payment-provider: public, with no user token; the signature is the only proof of origin. The body is read
 * as raw bytes (the signature covers them exactly as received) in a scope of its own, so that the JSON parser of the other
 * routes is not changed. Order: signature first, then the body is parsed; a body that is not what the contract says is a 400
 * after a valid signature. The use case reads the object back and acts on its state, never on the type of the event.
 */
export function registerWebhookRoutes(app: FastifyInstance, useCases: UseCases, options: WebhookOptions): void {
  void app.register((scope, _options, done) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, next) => {
      next(null, body);
    });

    scope.post("/v1/webhooks/payment-provider", { schema: schemas.webhook }, async (request) => {
      const rawBody = request.body as Buffer;
      const header = request.headers["provider-signature"];
      const check =
        options.secret === null
          ? ({ valid: false, reason: "no_secret" } as const)
          : verifyWebhookSignature({ secret: options.secret, header: typeof header === "string" ? header : undefined, rawBody, nowSeconds: options.nowSeconds() });
      if (!check.valid) {
        request.log.warn({ reason: check.reason }, "A webhook was refused");
        throw new HttpError(401, "invalid_signature", "The signature of the webhook is missing, wrong or too old");
      }
      const event = parseProviderEvent(rawBody);
      const status = await useCases.handleProviderEvent({ ...event, correlationId: request.correlationId });
      return { status };
    });
    done();
  });
}
