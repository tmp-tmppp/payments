import { describe, expect, it } from "vitest";
import { isUuid, parseReceivedEvent, parseTenantCreated, parseWithdrawalRefunded } from "../../src/domain/consumed-events.js";
import type { ReceivedEvent } from "../../src/domain/consumed-events.js";
import { TENANT_A } from "../support/harness.js";

const WITHDRAWAL = "018f3c1e-7a00-7000-8000-000000000042";

const envelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  specversion: "1.0",
  id: "evt-1",
  source: "/chance/tenants",
  type: "si.chance.tenants.TenantCreated.v1",
  subject: `tenant/${TENANT_A}`,
  time: "2026-11-01T10:00:00.000Z",
  datacontenttype: "application/json",
  tenantid: TENANT_A,
  correlationid: "corr-1",
  causationid: "req-1",
  data: { tenantId: TENANT_A, name: "Acme", slug: "acme", createdAt: "2026-11-01T10:00:00.000Z" },
  ...overrides,
});

const parsed = (overrides: Record<string, unknown> = {}): ReceivedEvent => {
  const event = parseReceivedEvent(envelope(overrides));
  if (event === null) throw new Error("the envelope should parse");
  return event;
};

describe("parseReceivedEvent", () => {
  it("reads the envelope of another publisher", () => {
    expect(parsed()).toMatchObject({ id: "evt-1", type: "si.chance.tenants.TenantCreated.v1", tenantId: TENANT_A, correlationId: "corr-1", causationId: "req-1" });
  });

  it("lower-cases the tenant id and fills optional text with an empty string", () => {
    const event = parseReceivedEvent(envelope({ tenantid: TENANT_A.toUpperCase(), correlationid: undefined, causationid: 5, source: undefined }));
    expect(event).toMatchObject({ tenantId: TENANT_A, correlationId: "", causationId: "", source: "" });
  });

  it.each([
    ["not an object", "text"],
    ["an array", []],
    ["null", null],
    ["another specversion", envelope({ specversion: "0.3" })],
    ["no id", envelope({ id: undefined })],
    ["an empty id", envelope({ id: "" })],
    ["an id over 255 characters", envelope({ id: "x".repeat(256) })],
    ["no type", envelope({ type: undefined })],
    ["a tenant id that is no UUID", envelope({ tenantid: "acme" })],
    ["no tenant id", envelope({ tenantid: undefined })],
    ["no data", envelope({ data: undefined })],
    ["data that is a list", envelope({ data: [1] })],
    ["an id with a NUL", envelope({ id: "evt\u00001" })],
    ["an id with a lone surrogate", envelope({ id: "evt-\ud800" })],
    ["a type with a lone surrogate", envelope({ type: "si.chance.\udc00" })],
    ["a source with a NUL", envelope({ source: "/chance\u0000" })],
    ["a correlation id with a lone surrogate", envelope({ correlationid: "corr-\ud83d" })],
    ["a causation id with a NUL", envelope({ causationid: "req\u0000" })],
  ])("refuses %s", (_name, value) => {
    expect(parseReceivedEvent(value)).toBeNull();
  });

  it("keeps text with a valid surrogate pair (an emoji is not a lone surrogate)", () => {
    expect(parsed({ id: "evt-😀", correlationid: "corr-😀" })).toMatchObject({ id: "evt-😀", correlationId: "corr-😀" });
  });
});

describe("parseTenantCreated", () => {
  it("takes the tenant id and ignores name and slug", () => {
    expect(parseTenantCreated(parsed())).toEqual({ tenantId: TENANT_A });
  });

  it("refuses data without a tenant id, with a bad one, or one that differs from the envelope's", () => {
    expect(parseTenantCreated(parsed({ data: {} }))).toBeNull();
    expect(parseTenantCreated(parsed({ data: { tenantId: "acme" } }))).toBeNull();
    expect(parseTenantCreated(parsed({ data: { tenantId: "018f3c1e-7a00-7000-8000-0000000000bb" } }))).toBeNull();
  });
});

describe("parseWithdrawalRefunded", () => {
  const refunded = (data: unknown) => parseWithdrawalRefunded(parsed({ type: "si.chance.trading.WithdrawalRefunded.v1", data }));

  it("reads the withdrawal id, the user and the amount", () => {
    expect(refunded({ withdrawalId: WITHDRAWAL.toUpperCase(), userId: "user-1", amount: 500 })).toEqual({ withdrawalId: WITHDRAWAL, userId: "user-1", amount: 500 });
  });

  it.each([
    ["no withdrawal id", { userId: "u", amount: 5 }],
    ["a withdrawal id that is no UUID", { withdrawalId: "w-1", userId: "u", amount: 5 }],
    ["no user", { withdrawalId: WITHDRAWAL, amount: 5 }],
    ["an empty user", { withdrawalId: WITHDRAWAL, userId: "", amount: 5 }],
    ["a user over 255 characters", { withdrawalId: WITHDRAWAL, userId: "u".repeat(256), amount: 5 }],
    ["a user with a NUL", { withdrawalId: WITHDRAWAL, userId: "u\u0000", amount: 5 }],
    ["a user with a lone surrogate", { withdrawalId: WITHDRAWAL, userId: "u\udfff", amount: 5 }],
    ["an amount of 0", { withdrawalId: WITHDRAWAL, userId: "u", amount: 0 }],
    ["an amount above the bound", { withdrawalId: WITHDRAWAL, userId: "u", amount: 1_000_001 }],
    ["a fractional amount", { withdrawalId: WITHDRAWAL, userId: "u", amount: 1.5 }],
    ["an amount as text", { withdrawalId: WITHDRAWAL, userId: "u", amount: "5" }],
  ])("refuses %s", (_name, data) => {
    expect(refunded(data)).toBeNull();
  });
});

describe("isUuid", () => {
  it("accepts a UUID in either case and nothing else", () => {
    expect(isUuid(TENANT_A)).toBe(true);
    expect(isUuid(TENANT_A.toUpperCase())).toBe(true);
    expect(isUuid(`${TENANT_A} `)).toBe(false);
    expect(isUuid(5)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
