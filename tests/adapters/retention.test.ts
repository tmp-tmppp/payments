import { describe, expect, it } from "vitest";
import { DAY_MS, DEFAULT_STREAM_MAX_AGE_DAYS, PUBLISHED_RETENTION_MS, idRetentionMs } from "../../src/adapters/retention.js";

describe("retention", () => {
  it("keeps the stream's messages and the published outbox rows 30 days by default", () => {
    expect(DEFAULT_STREAM_MAX_AGE_DAYS).toBe(30);
    expect(PUBLISHED_RETENTION_MS).toBe(30 * DAY_MS);
  });

  it("keeps processed and webhook ids one day longer than the streams keep their messages, never under 30 days", () => {
    expect(idRetentionMs(30)).toBe(31 * DAY_MS);
    expect(idRetentionMs(90)).toBe(91 * DAY_MS);
    expect(idRetentionMs(7)).toBe(30 * DAY_MS);
    expect(idRetentionMs(29)).toBe(30 * DAY_MS);
  });
});
