import type { CloudEvent } from "../../domain/events.js";
import type { EventPublisher, Logger } from "../../usecases/ports.js";

export interface PublishedMessage {
  subject: string;
  event: CloudEvent<unknown>;
  messageId: string;
}

/** Collects events in memory (tests) and logs them when given a logger (local runs without a broker). */
export class MemoryEventPublisher implements EventPublisher {
  readonly published: PublishedMessage[] = [];
  /** The next this many publish calls fail, like an unreachable broker. */
  failNext = 0;

  constructor(private readonly logger?: Logger) {}

  publish(subject: string, event: CloudEvent<unknown>, messageId: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error("The in-memory publisher was told to fail"));
    }
    this.published.push({ subject, event, messageId });
    this.logger?.info({ subject, eventId: messageId, type: event.type }, "Event published (in memory)");
    return Promise.resolve();
  }
}
