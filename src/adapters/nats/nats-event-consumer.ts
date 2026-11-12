import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { ConsumerMessages, JetStreamManager } from "@nats-io/jetstream";
import { connect, nanos } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import type { ConsumedEventHandler, Logger } from "../../usecases/ports.js";
import { handleDelivery } from "../events/delivery.js";

/** One durable consumer: which stream and subjects, and what to do with an event. */
export interface ConsumerSpec {
  stream: string;
  /** The durable name: the broker remembers the position under it, across restarts. */
  durable: string;
  filterSubject: string;
  handler: ConsumedEventHandler;
}

export interface NatsEventConsumerOptions {
  /** First wait after a failure, doubled up to maxRetryMs. Defaults 2000 and 30000. */
  retryMs?: number;
  maxRetryMs?: number;
}

const ACK_WAIT_MS = 60_000;

const isStreamMissing = (error: unknown): boolean =>
  error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.StreamNotFound;

/**
 * Durable JetStream consumers (ADR-053 inbox): TENANTS (TenantCreated) and TRADING (WithdrawalRefunded). Each consumer runs
 * in its own loop, so one that cannot start never holds back the others or the service: a missing stream, a refused
 * connection or a failed consumer is logged and tried again with a growing wait; the service starts and serves without
 * them. A message is acknowledged after its handler resolved (see delivery.ts), one message at a time, in order. A new durable
 * consumer starts at the first message of the stream, so a TenantCreated from before payments existed is not missed.
 */
export class NatsEventConsumer {
  private nc: NatsConnection | null = null;
  private connecting: Promise<NatsConnection> | null = null;
  private stopping = false;
  private loops: Promise<void>[] = [];
  private readonly active = new Set<ConsumerMessages>();
  private wake: Array<() => void> = [];

  constructor(
    private readonly url: string,
    private readonly logger: Logger,
    private readonly specs: readonly ConsumerSpec[],
    private readonly options: NatsEventConsumerOptions = {},
  ) {}

  /** Starts one loop per consumer; returns at once and never throws. */
  start(): void {
    if (this.loops.length > 0) return;
    this.stopping = false;
    this.loops = this.specs.map((spec) => this.run(spec));
  }

  /** Stops the loops, waits for the message in progress, and closes the connection. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const wake of this.wake) wake();
    for (const messages of this.active) messages.stop();
    await Promise.all(this.loops);
    this.loops = [];
    const nc = this.nc;
    this.nc = null;
    if (nc && !nc.isClosed()) await nc.drain().catch(() => undefined);
  }

  private connection(): Promise<NatsConnection> {
    if (this.nc && !this.nc.isClosed()) return Promise.resolve(this.nc);
    this.connecting ??= connect({ servers: this.url, name: "payments-consumers", maxReconnectAttempts: -1 })
      .then((nc) => {
        this.nc = nc;
        return nc;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private async ensureConsumer(manager: JetStreamManager, spec: ConsumerSpec): Promise<void> {
    await manager.consumers.add(spec.stream, {
      durable_name: spec.durable,
      filter_subject: spec.filterSubject,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      ack_wait: nanos(ACK_WAIT_MS),
      max_deliver: -1,
    });
  }

  private async run(spec: ConsumerSpec): Promise<void> {
    const base = this.options.retryMs ?? 2000;
    const max = this.options.maxRetryMs ?? 30_000;
    let failures = 0;
    while (!this.stopping) {
      try {
        const nc = await this.connection();
        await this.ensureConsumer(await jetstreamManager(nc), spec);
        const consumer = await jetstream(nc).consumers.get(spec.stream, spec.durable);
        // abort_on_missing_resource: when the stream or the durable consumer is deleted while this loop runs (a publisher
        // creating its stream again, an operator, lost broker storage), the iterator below throws instead of waiting for
        // a consumer that nobody creates; the catch logs it, and the next round creates the consumer again.
        const messages = await consumer.consume({ max_messages: 10, abort_on_missing_resource: true });
        this.active.add(messages);
        failures = 0;
        this.logger.info({ stream: spec.stream, durable: spec.durable, filter: spec.filterSubject }, "Consuming events");
        try {
          for await (const message of messages) {
            await handleDelivery(
              {
                data: message.data,
                subject: message.subject,
                deliveryCount: message.info.deliveryCount,
                ack: () => message.ack(),
                nak: (delayMs) => message.nak(delayMs),
                term: (reason) => message.term(reason),
              },
              spec.handler,
              this.logger,
            );
          }
        } finally {
          this.active.delete(messages);
        }
      } catch (error) {
        failures += 1;
        // A missing stream is expected while its owner has not started yet: no stack trace for it, only for real failures.
        if (isStreamMissing(error)) this.logger.warn({ stream: spec.stream, durable: spec.durable, attempt: failures }, "The stream of a consumer does not exist yet; trying again");
        else this.logger.warn({ stream: spec.stream, durable: spec.durable, attempt: failures, err: error }, "A consumer failed; trying again");
      }
      if (!this.stopping) await this.sleep(Math.min(max, base * 2 ** Math.min(failures, 10)));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wake = this.wake.filter((candidate) => candidate !== finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake.push(finish);
    });
  }
}
