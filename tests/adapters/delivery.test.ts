import { describe, expect, it } from "vitest";
import { RETRY_MAX_MS, handleDelivery, retryDelayMs } from "../../src/adapters/events/delivery.js";
import type { Delivery } from "../../src/adapters/events/delivery.js";
import type { ReceivedEvent } from "../../src/domain/consumed-events.js";
import { TenantNotReady, UnprocessableEvent } from "../../src/usecases/errors.js";
import { RecordingLogger, TENANT_A } from "../support/harness.js";

const eventJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    specversion: "1.0",
    id: "evt-1",
    source: "/chance/tenants",
    type: "si.chance.tenants.TenantCreated.v1",
    subject: `tenant/${TENANT_A}`,
    time: "2026-11-01T10:00:00.000Z",
    datacontenttype: "application/json",
    tenantid: TENANT_A,
    data: { tenantId: TENANT_A },
    ...overrides,
  });

function delivery(text: string, deliveryCount = 1) {
  const calls: string[] = [];
  const message: Delivery & { calls: string[]; delay?: number; reason?: string } = {
    data: new TextEncoder().encode(text),
    subject: `chance.tenants.TenantCreated.${TENANT_A}`,
    deliveryCount,
    calls,
    ack: () => calls.push("ack"),
    nak: (delayMs) => {
      calls.push("nak");
      message.delay = delayMs;
    },
    term: (reason) => {
      calls.push("term");
      message.reason = reason;
    },
  };
  return message;
}

describe("retryDelayMs", () => {
  it("doubles from one second and stops at thirty", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000]);
    expect(retryDelayMs(500)).toBe(RETRY_MAX_MS);
    expect(retryDelayMs(0)).toBe(1000);
  });
});

describe("handleDelivery", () => {
  it("parses the event, hands it over and acknowledges only after the handler has finished", async () => {
    const message = delivery(eventJson());
    const logger = new RecordingLogger();
    let received: ReceivedEvent | null = null;
    let finished = false;
    const result = await handleDelivery(
      message,
      async (event) => {
        received = event;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(message.calls).toEqual([]);
        finished = true;
      },
      logger,
    );
    expect(result).toBe("acked");
    expect(finished).toBe(true);
    expect(message.calls).toEqual(["ack"]);
    expect(received).toMatchObject({ id: "evt-1", tenantId: TENANT_A, data: { tenantId: TENANT_A } });
  });

  it("asks for a redelivery with a growing delay when the handler fails, and never acknowledges", async () => {
    const logger = new RecordingLogger();
    for (const [count, delay] of [[1, 1000], [3, 4000], [40, 30_000]] as const) {
      const message = delivery(eventJson(), count);
      expect(await handleDelivery(message, () => Promise.reject(new Error("database is down")), logger)).toBe("retry");
      expect(message.calls).toEqual(["nak"]);
      expect(message.delay).toBe(delay);
    }
    expect(logger.lines.every((line) => line.level === "warn")).toBe(true);
  });

  it("a tenant that is not ready yet is a retry, not a drop", async () => {
    const message = delivery(eventJson());
    expect(await handleDelivery(message, () => Promise.reject(new TenantNotReady(TENANT_A)), new RecordingLogger())).toBe("retry");
    expect(message.calls).toEqual(["nak"]);
  });

  it("drops an event the handler says can never be handled, with an error log", async () => {
    const message = delivery(eventJson());
    const logger = new RecordingLogger();
    expect(await handleDelivery(message, () => Promise.reject(new UnprocessableEvent("no tenant id")), logger)).toBe("dropped");
    expect(message.calls).toEqual(["term"]);
    expect(message.reason).toBe("no tenant id");
    expect(logger.lines.map((line) => line.level)).toEqual(["error"]);
  });

  it.each([
    ["text that is not JSON", "hello"],
    ["JSON that is not an event", JSON.stringify({ hello: "world" })],
    ["an event without a tenant id", eventJson({ tenantid: undefined })],
    ["an event of another specversion", eventJson({ specversion: "0.3" })],
    ["an empty message", ""],
  ])("drops %s without calling the handler", async (_name, text) => {
    const message = delivery(text);
    let called = false;
    const result = await handleDelivery(
      message,
      () => {
        called = true;
        return Promise.resolve();
      },
      new RecordingLogger(),
    );
    expect(result).toBe("dropped");
    expect(called).toBe(false);
    expect(message.calls).toEqual(["term"]);
  });
});
