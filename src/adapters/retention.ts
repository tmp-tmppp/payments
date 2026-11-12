export const DAY_MS = 24 * 3_600_000;

/**
 * The default of STREAM_MAX_AGE_DAYS: how long a message of the PAYMENTS stream is kept (its max age) and how long the
 * outbox relay keeps a row after it was published. The two agree, because a row that was published longer ago than the
 * stream keeps its messages is of no use any more. 30 days, not 7, so that a service started later still reads the
 * older events from the stream (decision of 2026-11-11); every service of the platform sets the same value.
 */
export const DEFAULT_STREAM_MAX_AGE_DAYS = 30;

/** The default max age and relay retention in milliseconds, for the NATS adapter and the relay, which do not import each other. */
export const PUBLISHED_RETENTION_MS = DEFAULT_STREAM_MAX_AGE_DAYS * DAY_MS;

/** The webhook ids of the provider are kept at least this long, whatever the streams keep. */
const MIN_ID_RETENTION_MS = 30 * DAY_MS;

/**
 * How long the ids of processed events (inbox) and of received webhooks are kept. The streams payments consumes keep
 * their messages for STREAM_MAX_AGE_DAYS (the same value in every service), and a consumer that is created again reads
 * them from the start, so an id must outlive the message by a margin of one day (clock differences, a consumer that was
 * down): an id purged earlier would let the same event be handled twice. Never less than 30 days for the webhooks.
 */
export function idRetentionMs(streamMaxAgeDays: number): number {
  return Math.max(MIN_ID_RETENTION_MS, (streamMaxAgeDays + 1) * DAY_MS);
}
