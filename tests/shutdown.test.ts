import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_TIMEOUT_MS, createShutdown } from "../src/shutdown.js";
import type { ShutdownSteps } from "../src/shutdown.js";
import { RecordingLogger, createHarness } from "./support/harness.js";

const ORDER = ["drain", "closeServer", "stopRelay", "stopJobs", "closeEvents", "closeDatabase"];

/** Steps that only write their name down; `overrides` replace single steps. */
function recordingSteps(order: string[], overrides: Partial<ShutdownSteps> = {}): ShutdownSteps {
  const step = (name: string) => () => {
    order.push(name);
    return Promise.resolve();
  };
  return {
    drain: () => {
      order.push("drain");
    },
    closeServer: step("closeServer"),
    stopRelay: step("stopRelay"),
    stopJobs: step("stopJobs"),
    closeEvents: step("closeEvents"),
    closeDatabase: step("closeDatabase"),
    ...overrides,
  };
}

// Only the timers the shutdown uses are faked: the web application under test needs the real setImmediate and Date.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("graceful shutdown", () => {
  it("drains at once, keeps serving for the delay, then stops the parts in order and exits with 0", async () => {
    vi.useRealTimers(); // the harness signs tokens and builds the application first
    const h = await createHarness({ probes: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const order: string[] = [];
    const exit = vi.fn();
    const logger = new RecordingLogger();
    const shutdown = createShutdown(
      recordingSteps(order, {
        drain: () => {
          order.push("drain");
          h.setDraining(true);
        },
        closeServer: async () => {
          order.push("closeServer");
          await h.app.close();
        },
      }),
      { logger, delayMs: 5000, exit },
    );

    const done = shutdown("SIGTERM");

    // Readiness turned 503 in the same moment, nothing was closed.
    expect(order).toEqual(["drain"]);
    expect(logger.lines[0]).toMatchObject({ level: "info", fields: { signal: "SIGTERM", delayMs: 5000 } });
    await vi.advanceTimersByTimeAsync(4999);
    expect(order).toEqual(["drain"]);
    // One millisecond before the delay is over the service still answers: not ready, but alive, and the API works.
    const ready = await h.app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ code: "shutting_down" });
    expect((await h.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/_probe/whoami", headers: await h.bearer() })).statusCode).toBe(200);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(order).toEqual(ORDER);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.lines.map((line) => line.message)).toEqual(["Shutting down: the readiness probe now answers 503", "Stopped"]);
    // The hard-exit timer is gone with the successful stop.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts the next step only when the one before has finished", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const exit = vi.fn();
    const shutdown = createShutdown(
      recordingSteps(order, {
        stopRelay: async () => {
          order.push("stopRelay");
          await gate;
          order.push("stopRelay finished");
        },
      }),
      { logger: new RecordingLogger(), delayMs: 0, exit },
    );

    const done = shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(0);

    // The loop is still finishing its batch: the worker, the broker and the pool wait for it.
    expect(order).toEqual(["drain", "closeServer", "stopRelay"]);
    release();
    await done;
    expect(order).toEqual(["drain", "closeServer", "stopRelay", "stopRelay finished", "stopJobs", "closeEvents", "closeDatabase"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not wait at all without a delay, and ignores a second signal", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown(recordingSteps(order), { logger: new RecordingLogger(), delayMs: 0, exit });

    await shutdown("SIGTERM");
    await shutdown("SIGINT");

    expect(order).toEqual(ORDER);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits with 1 when the steps take longer than the delay plus the timeout, and not earlier", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const logger = new RecordingLogger();
    const timers: Array<{ ms: number | undefined; timer: NodeJS.Timeout }> = [];
    const fakeSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((handler: () => void, ms?: number) => {
      const timer = fakeSetTimeout(handler, ms);
      timers.push({ ms, timer });
      return timer;
    });
    // The server never finishes closing (a connection that does not end).
    const shutdown = createShutdown(recordingSteps(order, { closeServer: () => new Promise<void>(() => undefined) }), { logger, delayMs: 2000, exit });

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(2000 + SHUTDOWN_TIMEOUT_MS - 1);
    expect(order).toEqual(["drain"]);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.lines.at(-1)).toMatchObject({ level: "error", message: "Shutdown took too long; exiting" });
    // The timer must not keep a finished process alive: it is unref'd.
    const hardExit = timers.find((entry) => entry.ms === 2000 + SHUTDOWN_TIMEOUT_MS);
    expect(hardExit?.timer.hasRef()).toBe(false);
  });

  it("takes the timeout from the options", async () => {
    const exit = vi.fn();
    const shutdown = createShutdown(recordingSteps([], { closeDatabase: () => new Promise<void>(() => undefined) }), {
      logger: new RecordingLogger(),
      delayMs: 0,
      timeoutMs: 250,
      exit,
    });

    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(249);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits with 1 when a step fails, logs why and does not run the steps after it", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const logger = new RecordingLogger();
    const failure = new Error("the relay cannot stop");
    const shutdown = createShutdown(
      recordingSteps(order, {
        stopRelay: () => {
          order.push("stopRelay");
          return Promise.reject(failure);
        },
      }),
      { logger, delayMs: 0, exit },
    );

    await shutdown("SIGTERM");

    expect(order).toEqual(["drain", "closeServer", "stopRelay"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.lines.at(-1)).toMatchObject({ level: "error", message: "Shutdown failed", fields: { err: failure } });
    expect(vi.getTimerCount()).toBe(0);
  });
});
