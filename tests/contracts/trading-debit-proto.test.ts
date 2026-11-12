import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as protoLoader from "@grpc/proto-loader";
import { describe, expect, it } from "vitest";
import { PROTO_LOADER_OPTIONS, TRADING_DEBIT_PROTO_FILE } from "../../src/adapters/trading/trading-grpc-client.js";
import { tradingDebit } from "../support/contracts.js";

// The copy of trading's gRPC contract (contracts/external/trading-debit.proto): the hash recorded in contracts/README.md,
// trading's own file when its repository is checked out beside this one, the image, and the REST body of the same debit.

const root = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const SOURCE = root("../trading/contracts/trading-debit.proto");
const copy = readFileSync(TRADING_DEBIT_PROTO_FILE);

describe("contracts/external/trading-debit.proto", () => {
  it("is the file the gRPC client loads", () => {
    expect(TRADING_DEBIT_PROTO_FILE).toBe(root("contracts/external/trading-debit.proto"));
  });

  it("has the SHA-256 recorded in contracts/README.md", () => {
    const readme = readFileSync(root("contracts/README.md"), "utf8");
    const row = readme.split("\n").find((line) => line.startsWith("| `external/trading-debit.proto` | `../trading/contracts/trading-debit.proto` |"));
    expect(row, "the row of the copy in contracts/README.md").toBeDefined();
    expect(row).toContain(`\`${createHash("sha256").update(copy).digest("hex")}\``);
  });

  it.skipIf(!existsSync(SOURCE))("equals trading's file (the sibling repository is checked out)", () => {
    expect(copy.equals(readFileSync(SOURCE)), "copy trading's file again and update its hash in contracts/README.md").toBe(true);
  });

  it("is shipped beside the compiled code: the Dockerfile copies it and .dockerignore lets it through", () => {
    expect(readFileSync(root("Dockerfile"), "utf8")).toMatch(/^COPY contracts\/external\/trading-debit\.proto \.\/contracts\/external\/trading-debit\.proto$/m);
    expect(readFileSync(root(".dockerignore"), "utf8").split("\n")).toContain("!contracts/external/trading-debit.proto");
  });

  it("asks for the same fields as the REST body of the debit, in the proto's names", () => {
    const definition = protoLoader.loadSync(TRADING_DEBIT_PROTO_FILE, PROTO_LOADER_OPTIONS);
    const message = definition["chance.trading.v1.DebitRequest"] as unknown as { type: { field: Array<{ name: string }> } };
    const snake = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const restFields = Object.keys(tradingDebit["components"].schemas.DebitRequest.properties as Record<string, unknown>).map(snake);
    expect(message.type.field.map((field) => field.name).sort()).toEqual(restFields.sort());
    expect(definition["chance.trading.v1.Debits"]).toHaveProperty("DebitCredits");
  });
});
