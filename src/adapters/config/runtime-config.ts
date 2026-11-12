import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger, RuntimeSettings } from "../../usecases/ports.js";

// ADR-037: runtime keys from a file the chart mounts from a ConfigMap. The service reads it at start and again whenever it
// changes, without a restart:
//   - A ConfigMap volume updates by swapping a symlink ("..data") inside the mounted directory, so the file itself never
//     "changes". The DIRECTORY is watched (every event in it triggers a read), and the file is also read on a poll, because
//     a watch can miss an update (and a subPath mount, which never updates, is not supported at all).
//   - File format: one JSON object, for example {"forcePayoutFailure": true, "logLevel": "debug"}. Unknown keys are ignored.
//   - ADR-037 order: defaults, then the mounted file, then the environment. A key the environment sets wins over the file
//     (the chart never puts a runtime key in the environment, so the file controls it in a cluster); a key only the file sets
//     takes the file's value; a key the file lacks keeps the default; a missing file means all startup values. A file or a
//     value that is not valid is ignored with a warning and the last good values stay, so a typo cannot turn the flag off or
//     the logging to a level that does not exist.

export interface RuntimeValues {
  forcePayoutFailure: boolean;
  logLevel: string;
}

export interface RuntimeConfigOptions {
  /** The mounted file; null: nothing is watched and the startup values stay. */
  filePath: string | null;
  /** The file is read this often in any case. */
  pollMs: number;
  /** Defaults and environment, resolved by loadConfig. */
  startup: RuntimeValues;
  /** The keys the environment set explicitly: they keep their startup value whatever the file says. */
  fromEnv?: readonly (keyof RuntimeValues)[];
  validLogLevels: readonly string[];
  logger: Logger;
  /** Called with the new level when the effective log level changes. */
  onLogLevel?: (level: string) => void;
  /** Replaced in tests. */
  readFile?: (path: string) => Promise<string>;
  /** Events of the directory watch are merged for this long before one read. Default 100. */
  debounceMs?: number;
}

export interface ParsedRuntimeConfig {
  values: Partial<RuntimeValues>;
  problems: string[];
  /** Keys whose value is wrong (or all keys, when the file as a whole is): they keep their last good value. */
  invalidKeys: Array<keyof RuntimeValues>;
}

/** Reads the text of the file. Never throws: what is wrong is in `problems`, what is right is in `values`. */
export function parseRuntimeConfig(text: string, validLogLevels: readonly string[]): ParsedRuntimeConfig {
  const values: Partial<RuntimeValues> = {};
  const problems: string[] = [];
  const invalidKeys: Array<keyof RuntimeValues> = [];
  const all: Array<keyof RuntimeValues> = ["forcePayoutFailure", "logLevel"];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { values, problems: ["the file is not valid JSON"], invalidKeys: all };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { values, problems: ["the file must hold one JSON object"], invalidKeys: all };
  const record = json as Record<string, unknown>;
  const flag = record["forcePayoutFailure"];
  if (flag !== undefined) {
    if (typeof flag === "boolean") values.forcePayoutFailure = flag;
    else if (flag === "true" || flag === "false") values.forcePayoutFailure = flag === "true";
    else {
      problems.push("forcePayoutFailure must be true or false");
      invalidKeys.push("forcePayoutFailure");
    }
  }
  const level = record["logLevel"];
  if (level !== undefined) {
    if (typeof level === "string" && validLogLevels.includes(level)) values.logLevel = level;
    else {
      problems.push(`logLevel must be one of: ${validLogLevels.join(", ")}`);
      invalidKeys.push("logLevel");
    }
  }
  return { values, problems, invalidKeys };
}

export class RuntimeConfig implements RuntimeSettings {
  private current: RuntimeValues;
  private lastText: string | null | undefined = undefined;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private reading: Promise<boolean> = Promise.resolve(false);

  constructor(private readonly options: RuntimeConfigOptions) {
    this.current = { ...options.startup };
  }

  forcePayoutFailure(): boolean {
    return this.current.forcePayoutFailure;
  }

  logLevel(): string {
    return this.current.logLevel;
  }

  /** Reads the file once, then watches the directory and polls. Never throws: a file that cannot be read keeps the startup values. */
  async start(): Promise<void> {
    const { filePath } = this.options;
    if (filePath === null) return;
    await this.reload();
    try {
      this.watcher = watch(dirname(filePath), { persistent: false }, () => this.scheduleReload());
      this.watcher.on("error", (error) => this.options.logger.warn({ err: error }, "Watching the runtime configuration directory failed; only the poll remains"));
    } catch (error) {
      this.options.logger.warn({ err: error }, "The runtime configuration directory cannot be watched; only the poll reads it");
    }
    this.timer = setInterval(() => void this.reload(), this.options.pollMs);
    this.timer.unref();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }

  /** Reads the file now; true when an effective value changed. Reads never overlap. */
  reload(): Promise<boolean> {
    this.reading = this.reading.then(() => this.readOnce());
    return this.reading;
  }

  private scheduleReload(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.reload();
    }, this.options.debounceMs ?? 100);
    this.debounce.unref();
  }

  private async readOnce(): Promise<boolean> {
    const { filePath, logger } = this.options;
    if (filePath === null) return false;
    let text: string | null;
    try {
      text = await (this.options.readFile ?? ((path) => readFile(path, "utf8")))(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ err: error }, "The runtime configuration file cannot be read; the last values stay");
        return false;
      }
      text = null;
    }
    // The same text as last time changes nothing and says nothing.
    if (text === this.lastText) return false;
    this.lastText = text;
    let next: RuntimeValues = { ...this.options.startup };
    if (text !== null) {
      const parsed = parseRuntimeConfig(text, this.options.validLogLevels);
      for (const problem of parsed.problems) logger.warn({ problem }, "The runtime configuration file has a problem");
      next = { ...next, ...parsed.values };
      // The environment is applied last (ADR-037): a key it set keeps its startup value.
      for (const key of this.options.fromEnv ?? []) (next as unknown as Record<string, unknown>)[key] = this.options.startup[key];
      // A value that is wrong keeps its last good value, not the startup one.
      for (const key of parsed.invalidKeys) (next as unknown as Record<string, unknown>)[key] = this.current[key];
    }
    const changed = next.forcePayoutFailure !== this.current.forcePayoutFailure || next.logLevel !== this.current.logLevel;
    const levelChanged = next.logLevel !== this.current.logLevel;
    this.current = next;
    if (changed) logger.info({ forcePayoutFailure: next.forcePayoutFailure, logLevel: next.logLevel }, "Runtime configuration changed");
    if (levelChanged) this.options.onLogLevel?.(next.logLevel);
    return changed;
  }
}
