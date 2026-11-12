import { parseReceivedEvent } from "../../domain/consumed-events.js";
import { UnprocessableEvent } from "../../usecases/errors.js";
import type { ConsumedEventHandler, Logger } from "../../usecases/ports.js";

// What happens to one message from the broker, apart from the broker itself (nats-event-consumer.ts feeds it): parse,
// hand over to the use case, and acknowledge only after the use case has finished, which is after its transaction has
// committed. A message is therefore never lost: a crash between the commit and the ack means a redelivery, and the inbox
// record stored in the same transaction as the change turns that redelivery into a no-op.

/** The part of a JetStream message this module needs. */
export interface Delivery {
  data: Uint8Array;
  subject: string;
  /** 1 for the first delivery. */
  deliveryCount: number;
  ack(): void;
  nak(delayMs?: number): void;
  term(reason?: string): void;
}

/** acked: handled and acknowledged. retry: the handler failed, delivery is repeated later. dropped: it can never be handled, no redelivery. */
export type DeliveryResult = "acked" | "retry" | "dropped";

export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;

/** Wait before the next delivery after the n-th failed one: 1, 2, 4 ... seconds, at most 30. */
export function retryDelayMs(deliveryCount: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(deliveryCount - 1, 0), 10));
}

export async function handleDelivery(delivery: Delivery, handler: ConsumedEventHandler, logger: Logger): Promise<DeliveryResult> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(delivery.data));
  } catch {
    logger.error({ subject: delivery.subject }, "A consumed message is not JSON; dropping it");
    delivery.term("not JSON");
    return "dropped";
  }
  const event = parseReceivedEvent(json);
  if (event === null) {
    logger.error({ subject: delivery.subject }, "A consumed message is not a CloudEvent with an id, a type, a tenant id and storable text; dropping it");
    delivery.term("not a valid CloudEvent");
    return "dropped";
  }
  try {
    await handler(event);
  } catch (error) {
    if (error instanceof UnprocessableEvent) {
      logger.error({ eventId: event.id, subject: delivery.subject, err: error }, "A consumed event cannot be handled; dropping it");
      delivery.term(error.message);
      return "dropped";
    }
    // Never given up: a failure of the database or a tenant that is not ready yet passes. Messages behind it go on.
    logger.warn({ eventId: event.id, subject: delivery.subject, deliveryCount: delivery.deliveryCount, err: error }, "Handling a consumed event failed; it will be delivered again");
    delivery.nak(retryDelayMs(delivery.deliveryCount));
    return "retry";
  }
  delivery.ack();
  return "acked";
}
