import { jetstream, jetstreamManager, JetStreamApiCodes, JetStreamApiError, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import type { JetStreamClient } from "@nats-io/jetstream";
import { connect, nanos } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import type { CloudEvent } from "../../domain/events.js";
import { SUBJECT_PREFIX } from "../../domain/events.js";
import type { EventPublisher, Logger } from "../../usecases/ports.js";
import { PUBLISHED_RETENTION_MS } from "../retention.js";

export const STREAM_NAME = "PAYMENTS";
const DUPLICATE_WINDOW_MS = 2 * 60_000;

interface Connected {
  nc: NatsConnection;
  js: JetStreamClient;
}

/**
 * Publishes the events to NATS JetStream (ADR-030). The connection is made when it is first needed and again
 * after a failure, so the service starts and answers requests while the broker is down; the events then wait in
 * the outbox. The stream is created or updated on every new connection.
 */
export class NatsEventPublisher implements EventPublisher {
  private connected: Connected | null = null;
  private connecting: Promise<Connected> | null = null;

  constructor(
    private readonly url: string,
    private readonly logger: Logger,
    /** The stream's max age (STREAM_MAX_AGE_DAYS); an existing stream gets it on the next connection. */
    private readonly maxAgeMs: number = PUBLISHED_RETENTION_MS,
  ) {}

  async publish(subject: string, event: CloudEvent<unknown>, messageId: string): Promise<void> {
    const { js } = await this.ready();
    // The message id deduplicates inside the stream's duplicate window.
    await js.publish(subject, new TextEncoder().encode(JSON.stringify(event)), { msgID: messageId });
  }

  /** Connects and ensures the stream; used at startup (best effort) and before every publish. */
  ready(): Promise<Connected> {
    if (this.connected && !this.connected.nc.isClosed()) return Promise.resolve(this.connected);
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Flushes what is pending and closes the connection. */
  async close(): Promise<void> {
    const current = this.connected;
    this.connected = null;
    if (current && !current.nc.isClosed()) await current.nc.drain();
  }

  private async connect(): Promise<Connected> {
    const nc = await connect({ servers: this.url, name: "payments", maxReconnectAttempts: -1 });
    try {
      const manager = await jetstreamManager(nc);
      const config = {
        name: STREAM_NAME,
        subjects: [`${SUBJECT_PREFIX}.>`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        // The relay deletes its published rows after the same time (both from STREAM_MAX_AGE_DAYS).
        max_age: nanos(this.maxAgeMs),
        duplicate_window: nanos(DUPLICATE_WINDOW_MS),
      };
      try {
        await manager.streams.info(STREAM_NAME);
        await manager.streams.update(STREAM_NAME, config);
      } catch (error) {
        const missing = error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.StreamNotFound;
        if (!missing) throw error;
        await manager.streams.add(config);
      }
      this.logger.info({ stream: STREAM_NAME }, "Connected to NATS and ensured the stream");
      this.connected = { nc, js: jetstream(nc) };
      return this.connected;
    } catch (error) {
      await nc.close().catch(() => undefined);
      throw error;
    }
  }
}
