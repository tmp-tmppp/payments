import { runDueWork } from "../../usecases/jobs.js";
import type { JobCounts } from "../../usecases/jobs.js";
import type { PaymentsDeps } from "../../usecases/ports.js";
import { DEFAULT_STREAM_MAX_AGE_DAYS, idRetentionMs } from "../retention.js";

export interface JobRunnerOptions {
  deps: PaymentsDeps;
  /** Wait between passes when nothing is due. */
  pollMs: number;
  /** Rows taken per tenant and job in one pass. Default 20. */
  batchSize?: number;
  /** Upper bound of the wait after a pass that failed. Default 30 s. */
  maxBackoffMs?: number;
  /** How long consumed event ids and provider event ids are kept. Default idRetentionMs of the default stream age (31 days). */
  retentionMs?: number;
  /** Old ids are deleted at most this often. Default 1 hour. */
  purgeEveryMs?: number;
}

/**
 * The loop around the jobs of src/usecases/jobs.ts: deposit checks and expiry, repeated debits and payouts. It looks for due
 * work every `pollMs`, at once again when a batch was full, and backs off when a pass fails. It also deletes old ids of the
 * inbox and of the provider events (an hour apart at most). One loop per process; replicas are kept apart by the leases in
 * the jobs, not by this class.
 */
export class JobRunner {
  private readonly batchSize: number;
  private readonly maxBackoffMs: number;
  private readonly retentionMs: number;
  private readonly purgeEveryMs: number;
  private lastPurgeAt: number | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(private readonly options: JobRunnerOptions) {
    this.batchSize = options.batchSize ?? 20;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.retentionMs = options.retentionMs ?? idRetentionMs(DEFAULT_STREAM_MAX_AGE_DAYS);
    this.purgeEveryMs = options.purgeEveryMs ?? 3_600_000;
  }

  /** One pass of every job. */
  runOnce(): Promise<JobCounts> {
    return runDueWork(this.options.deps, this.batchSize);
  }

  /** Deletes the ids older than the retention time, if the last attempt is at least `purgeEveryMs` ago (the first call always runs). */
  async purgeIfDue(): Promise<number> {
    const { store, clock, logger } = this.options.deps;
    const now = clock.now().getTime();
    if (this.lastPurgeAt !== null && now - this.lastPurgeAt < this.purgeEveryMs) return 0;
    this.lastPurgeAt = now;
    const olderThan = new Date(now - this.retentionMs);
    const purged = (await store.repositories.inbox.purgeProcessed(olderThan)) + (await store.repositories.providerEvents.purgeReceived(olderThan));
    if (purged > 0) logger.info({ purged }, "Deleted old event ids");
    return purged;
  }

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.loop();
  }

  /** Stops the loop and waits until the pass in progress has finished. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = null;
  }

  private async loop(): Promise<void> {
    const { logger } = this.options.deps;
    let failures = 0;
    while (!this.stopping) {
      let delay = this.options.pollMs;
      try {
        const counts = await this.runOnce();
        failures = 0;
        if (Math.max(counts.deposits, counts.debits, counts.payouts) >= this.batchSize) delay = 0;
      } catch (error) {
        failures += 1;
        delay = Math.min(this.maxBackoffMs, this.options.pollMs * 2 ** Math.min(failures, 16));
        logger.error({ err: error }, "A pass of the background jobs failed");
      }
      if (!this.stopping) {
        try {
          await this.purgeIfDue();
        } catch (error) {
          logger.warn({ err: error }, "The old event ids could not be deleted");
        }
      }
      if (delay > 0 && !this.stopping) await this.sleep(delay);
    }
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
