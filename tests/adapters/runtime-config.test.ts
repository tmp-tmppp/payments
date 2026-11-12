import { mkdir, mkdtemp, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeConfig, parseRuntimeConfig } from "../../src/adapters/config/runtime-config.js";
import type { RuntimeConfigOptions } from "../../src/adapters/config/runtime-config.js";
import { LOG_LEVELS } from "../../src/config.js";
import { RecordingLogger } from "../support/harness.js";

describe("parseRuntimeConfig", () => {
  it("reads the flag as a boolean or as the text true/false, and a valid log level", () => {
    expect(parseRuntimeConfig('{"forcePayoutFailure": true, "logLevel": "debug"}', LOG_LEVELS)).toEqual({ values: { forcePayoutFailure: true, logLevel: "debug" }, problems: [], invalidKeys: [] });
    expect(parseRuntimeConfig('{"forcePayoutFailure": "false"}', LOG_LEVELS).values).toEqual({ forcePayoutFailure: false });
    expect(parseRuntimeConfig('{"forcePayoutFailure": "true"}', LOG_LEVELS).values).toEqual({ forcePayoutFailure: true });
  });

  it("ignores unknown keys", () => {
    expect(parseRuntimeConfig('{"somethingElse": 1}', LOG_LEVELS)).toEqual({ values: {}, problems: [], invalidKeys: [] });
  });

  it("reports a wrong value by key, and a file that is no JSON object as wrong in every key", () => {
    const wrong = parseRuntimeConfig('{"forcePayoutFailure": "maybe", "logLevel": "loud"}', LOG_LEVELS);
    expect(wrong.values).toEqual({});
    expect(wrong.invalidKeys).toEqual(["forcePayoutFailure", "logLevel"]);
    expect(wrong.problems).toHaveLength(2);
    for (const text of ["not json", "[1]", "5", "null", ""]) {
      const parsed = parseRuntimeConfig(text, LOG_LEVELS);
      expect(parsed.values).toEqual({});
      expect(parsed.invalidKeys).toEqual(["forcePayoutFailure", "logLevel"]);
      expect(parsed.problems).toHaveLength(1);
    }
  });
});

describe("RuntimeConfig", () => {
  let directory: string;
  let file: string;
  let logger: RecordingLogger;
  let levels: string[];
  const created: RuntimeConfig[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "payments-runtime-config-"));
    file = join(directory, "runtime.json");
    logger = new RecordingLogger();
    levels = [];
  });

  afterEach(async () => {
    for (const config of created.splice(0)) config.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const make = (overrides: Partial<RuntimeConfigOptions> = {}) => {
    const config = new RuntimeConfig({
      filePath: file,
      pollMs: 3_600_000,
      startup: { forcePayoutFailure: false, logLevel: "info" },
      validLogLevels: LOG_LEVELS,
      logger,
      onLogLevel: (level) => levels.push(level),
      ...overrides,
    });
    created.push(config);
    return config;
  };

  it("with no file the startup values stay and nothing is watched", async () => {
    const config = make({ filePath: null, startup: { forcePayoutFailure: true, logLevel: "warn" } });
    await config.start();
    expect(await config.reload()).toBe(false);
    expect([config.forcePayoutFailure(), config.logLevel()]).toEqual([true, "warn"]);
  });

  it("a file that does not exist yet means the startup values; it is picked up when it appears", async () => {
    const config = make();
    await config.start();
    expect(config.forcePayoutFailure()).toBe(false);
    await writeFile(file, '{"forcePayoutFailure": true, "logLevel": "debug"}');
    expect(await config.reload()).toBe(true);
    expect([config.forcePayoutFailure(), config.logLevel()]).toEqual([true, "debug"]);
    expect(levels).toEqual(["debug"]);
  });

  it("a key only the file sets takes the file's value, a key it lacks keeps the default, a removed file restores all of them", async () => {
    await writeFile(file, '{"forcePayoutFailure": true}');
    const config = make({ startup: { forcePayoutFailure: false, logLevel: "warn" } });
    await config.start();
    expect([config.forcePayoutFailure(), config.logLevel()]).toEqual([true, "warn"]);
    await unlink(file);
    expect(await config.reload()).toBe(true);
    expect([config.forcePayoutFailure(), config.logLevel()]).toEqual([false, "warn"]);
  });

  it("ADR-037 order: defaults, then the file, then the environment: a key the environment set wins over the file", async () => {
    await writeFile(file, '{"forcePayoutFailure": true, "logLevel": "debug"}');
    const config = make({ startup: { forcePayoutFailure: false, logLevel: "warn" }, fromEnv: ["forcePayoutFailure"] });
    await config.start();
    // forcePayoutFailure came from the environment (false) and stays false; logLevel comes from the file.
    expect([config.forcePayoutFailure(), config.logLevel()]).toEqual([false, "debug"]);
    await writeFile(file, '{"forcePayoutFailure": true, "logLevel": "trace"}');
    await config.reload();
    expect([config.forcePayoutFailure(), config.logLevel()]).toEqual([false, "trace"]);
  });

  it("says nothing and changes nothing when the text is the same as last time", async () => {
    await writeFile(file, '{"forcePayoutFailure": true}');
    const config = make();
    await config.start();
    const changes = () => logger.lines.filter((line) => line.message === "Runtime configuration changed").length;
    expect(changes()).toBe(1);
    expect(await config.reload()).toBe(false);
    expect(await config.reload()).toBe(false);
    expect(changes()).toBe(1);
  });

  it("a wrong value keeps the last good one and warns; a key that is absent goes back to the startup value", async () => {
    await writeFile(file, '{"forcePayoutFailure": true, "logLevel": "debug"}');
    const config = make();
    await config.start();
    await writeFile(file, '{"forcePayoutFailure": "maybe", "logLevel": "trace"}');
    await config.reload();
    expect([config.forcePayoutFailure(), config.logLevel()]).toEqual([true, "trace"]);
    await writeFile(file, "{ this is not json");
    await config.reload();
    expect([config.forcePayoutFailure(), config.logLevel()]).toEqual([true, "trace"]);
    expect(logger.lines.filter((line) => line.level === "warn").length).toBeGreaterThanOrEqual(2);
    await writeFile(file, "{}");
    await config.reload();
    expect([config.forcePayoutFailure(), config.logLevel()]).toEqual([false, "info"]);
    expect(levels).toEqual(["debug", "trace", "info"]);
  });

  it("a file that cannot be read keeps the last values and warns, it does not throw", async () => {
    const failing = vi.fn<(path: string) => Promise<string>>().mockResolvedValueOnce('{"forcePayoutFailure": true}').mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    const config = make({ readFile: failing });
    await config.start();
    expect(config.forcePayoutFailure()).toBe(true);
    expect(await config.reload()).toBe(false);
    expect(config.forcePayoutFailure()).toBe(true);
    expect(logger.lines.some((line) => line.level === "warn" && line.message?.includes("cannot be read"))).toBe(true);
  });

  it("follows a ConfigMap-style update: the file is a link into ..data, and an update swaps the ..data link", async () => {
    await mkdir(join(directory, "..v1"));
    await writeFile(join(directory, "..v1", "runtime.json"), '{"forcePayoutFailure": false}');
    await symlink("..v1", join(directory, "..data"));
    await symlink(join("..data", "runtime.json"), file);
    const config = make();
    await config.start();
    expect(config.forcePayoutFailure()).toBe(false);

    await mkdir(join(directory, "..v2"));
    await writeFile(join(directory, "..v2", "runtime.json"), '{"forcePayoutFailure": true}');
    await symlink("..v2", join(directory, "..data_tmp"));
    await rename(join(directory, "..data_tmp"), join(directory, "..data"));
    expect(await readlink(join(directory, "..data"))).toBe("..v2");
    expect(await config.reload()).toBe(true);
    expect(config.forcePayoutFailure()).toBe(true);
  });

  it("notices a change by itself: the poll alone is enough", async () => {
    await writeFile(file, '{"forcePayoutFailure": false}');
    const config = make({ pollMs: 25 });
    await config.start();
    await writeFile(file, '{"forcePayoutFailure": true}');
    await vi.waitFor(() => expect(config.forcePayoutFailure()).toBe(true), { timeout: 3000, interval: 20 });
  });

  it("notices a change by itself: the directory watch, with a poll that never fires", async () => {
    await writeFile(file, '{"forcePayoutFailure": false}');
    const config = make({ pollMs: 3_600_000, debounceMs: 10 });
    await config.start();
    if (logger.lines.some((line) => line.message?.includes("cannot be watched"))) return; // no inotify here: the poll is the fallback
    await writeFile(file, '{"forcePayoutFailure": true}');
    await vi.waitFor(() => expect(config.forcePayoutFailure()).toBe(true), { timeout: 3000, interval: 20 });
  });

  it("stop() can be called twice, and a config without start() can be stopped", () => {
    const config = make();
    config.stop();
    config.stop();
    expect(config.forcePayoutFailure()).toBe(false);
  });
});
