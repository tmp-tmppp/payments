import type { Clock, EventPublisher, Logger, Store } from "../../usecases/ports.js";
import { PUBLISHED_RETENTION_MS } from "../retention.js";

export interface RelayOptions {
  store: Store;
  publisher: EventPublisher;
  clock: Clock;
  logger: Logger;
  /** Wait between polls when the outbox is empty. */
  pollMs: number;
  /** Rows claimed per transaction. */
  batchSize?: number;
  /** Upper bound of the wait after failed publishes. */
  maxBackoffMs?: number;
  /** How long a published row is kept. Default 7 days, the max age of the stream (see NatsEventPublisher). */
  retentionMs?: number;
  /** Published rows are deleted at most this often. Default 1 hour. */
  purgeEveryMs?: number;
}

const PURGE_EVERY_MS = 3_600_000;

export interface RunResult {
  published: number;
  failed: boolean;
}

/**
 * Transactional outbox relay (REL-01, ADR-031): polls the outbox, publishes unsent rows in order and marks them.
 * Only one instance publishes at a time: the claim takes an advisory lock that lasts until the end of its
 * transaction and returns no rows while another instance holds it, so the events of a tenant keep their order with
 * several replicas (a rolling update runs two for a while). The rows are also claimed with FOR UPDATE SKIP LOCKED.
 * A failed publish stops the batch (the order is kept), counts an attempt and backs off.
 * Delivery is at least once: the event id is the deduplication id on the broker and in every consumer.
 * Published rows are deleted after the retention time, at most once an hour (purgeIfDue).
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly maxBackoffMs: number;
  private readonly retentionMs: number;
  private readonly purgeEveryMs: number;
  private lastPurgeAt: number | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(private readonly options: RelayOptions) {
    this.batchSize = options.batchSize ?? 50;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.retentionMs = options.retentionMs ?? PUBLISHED_RETENTION_MS;
    this.purgeEveryMs = options.purgeEveryMs ?? PURGE_EVERY_MS;
  }

  /** One poll: claims a batch in a transaction and publishes it. */
  runOnce(): Promise<RunResult> {
    const { store, publisher, clock, logger } = this.options;
    return store.transaction(async (repositories) => {
      const rows = await repositories.outbox.claimBatch(this.batchSize);
      let published = 0;
      for (const row of rows) {
        try {
          await publisher.publish(row.subject, row.payload, row.id);
          await repositories.outbox.markPublished(row.id, clock.now());
          published += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await repositories.outbox.markFailed(row.id, message);
          logger.warn({ eventId: row.id, subject: row.subject, attempts: row.attempts + 1, err: error }, "Publishing an event failed");
          return { published, failed: true };
        }
      }
      return { published, failed: false };
    });
  }

  /**
   * Deletes the rows that were published longer ago than the retention time, if the last attempt is at least
   * purgeEveryMs ago (the first call always runs). Returns how many rows went. The attempt counts even when it
   * fails, so a database that is down is not asked again at every poll.
   */
  async purgeIfDue(): Promise<number> {
    const { store, clock, logger } = this.options;
    const now = clock.now().getTime();
    if (this.lastPurgeAt !== null && now - this.lastPurgeAt < this.purgeEveryMs) return 0;
    this.lastPurgeAt = now;
    const purged = await store.repositories.outbox.purgePublished(new Date(now - this.retentionMs));
    if (purged > 0) logger.info({ purged }, "Deleted published events from the outbox");
    return purged;
  }

  /** Starts the polling loop; it runs until stop() is called. */
  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.loop();
  }

  /** Stops the loop and waits until the poll in progress has finished. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = null;
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      let delay = this.options.pollMs;
      try {
        const result = await this.runOnce();
        if (result.failed) {
          failures += 1;
          delay = this.backoff(failures);
        } else {
          failures = 0;
          if (result.published >= this.batchSize) delay = 0;
        }
      } catch (error) {
        failures += 1;
        delay = this.backoff(failures);
        this.options.logger.error({ err: error }, "The outbox relay could not read the outbox");
      }
      if (!this.stopping) {
        try {
          await this.purgeIfDue();
        } catch (error) {
          this.options.logger.warn({ err: error }, "The outbox relay could not delete old published events");
        }
      }
      if (delay > 0 && !this.stopping) await this.sleep(delay);
    }
  }

  private backoff(failures: number): number {
    const exponential = Math.min(this.maxBackoffMs, this.options.pollMs * 2 ** Math.min(failures, 16));
    return Math.round(exponential / 2 + Math.random() * (exponential / 2));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
    });
  }
}
