import { describe, expect, it } from "vitest";
import { WEBHOOK_TOLERANCE_SECONDS, parseSignatureHeader, signWebhook, verifyWebhookSignature } from "../../src/domain/webhook-signature.js";

// The worked test vector of payment-provider/contracts/README.md (the secret is a made-up test value, not a credential).
const SECRET = "test-vector-webhook-secret";
const T = "1767225600";
const BODY =
  '{"id":"evt_Zm9vYmFyZm9vYmFyZm9vYmFy","type":"checkout.session.completed","created":"2026-01-01T00:00:00.000Z","data":{"object":"checkout_session","id":"cs_YmF6cXV4YmF6cXV4YmF6cXV4"}}';
const V1 = "9af47717a62148755f24884229bfac1ff872ad81e86e154946e61eb071c37ba9";
const HEADER = `t=${T},v1=${V1}`;
const NOW = Number(T);

const check = (overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) =>
  verifyWebhookSignature({ secret: SECRET, header: HEADER, rawBody: BODY, nowSeconds: NOW, ...overrides });

describe("webhook signature: the provider's worked test vector", () => {
  it("has the 182 bytes the README states, and signs to the README's v1", () => {
    expect(Buffer.byteLength(BODY)).toBe(182);
    expect(signWebhook(SECRET, T, BODY).toString("hex")).toBe(V1);
  });

  it("accepts the vector, the body as a string and as bytes", () => {
    expect(check()).toEqual({ valid: true });
    expect(check({ rawBody: Buffer.from(BODY) })).toEqual({ valid: true });
  });

  it("accepts a timestamp inside the tolerance on both sides and refuses one outside it", () => {
    expect(check({ nowSeconds: NOW + WEBHOOK_TOLERANCE_SECONDS })).toEqual({ valid: true });
    expect(check({ nowSeconds: NOW - WEBHOOK_TOLERANCE_SECONDS })).toEqual({ valid: true });
    expect(check({ nowSeconds: NOW + WEBHOOK_TOLERANCE_SECONDS + 1 })).toEqual({ valid: false, reason: "stale_timestamp" });
    expect(check({ nowSeconds: NOW - WEBHOOK_TOLERANCE_SECONDS - 1 })).toEqual({ valid: false, reason: "stale_timestamp" });
    expect(check({ nowSeconds: NOW + 60, toleranceSeconds: 30 })).toEqual({ valid: false, reason: "stale_timestamp" });
  });
});

describe("webhook signature: what is refused", () => {
  it("a wrong secret", () => {
    expect(check({ secret: "another-secret" })).toEqual({ valid: false, reason: "no_matching_signature" });
  });

  it("a body that is one byte different, also a re-serialized copy", () => {
    expect(check({ rawBody: `${BODY} ` })).toEqual({ valid: false, reason: "no_matching_signature" });
    expect(check({ rawBody: JSON.stringify(JSON.parse(BODY), null, 1) })).toEqual({ valid: false, reason: "no_matching_signature" });
  });

  it("a signature made for another timestamp: t cannot be moved to a fresh time", () => {
    const fresh = String(NOW + 100);
    expect(check({ header: `t=${fresh},v1=${V1}`, nowSeconds: NOW + 100 })).toEqual({ valid: false, reason: "no_matching_signature" });
  });

  it("a missing or empty header", () => {
    expect(check({ header: undefined })).toEqual({ valid: false, reason: "missing_header" });
    expect(check({ header: "" })).toEqual({ valid: false, reason: "missing_header" });
    expect(check({ header: "   " })).toEqual({ valid: false, reason: "missing_header" });
  });

  it.each([
    ["no timestamp", `v1=${V1}`],
    ["no signature", `t=${T}`],
    ["a part without '='", `t=${T},v1`],
    ["a timestamp that is not digits", `t=abc,v1=${V1}`],
    ["a negative timestamp", `t=-5,v1=${V1}`],
    ["a timestamp of 13 digits", `t=1767225600000,v1=${V1}`],
    ["an empty timestamp", `t=,v1=${V1}`],
    ["two timestamps", `t=${T},t=${T},v1=${V1}`],
    ["only commas", ",,,"],
    ["a different scheme only", `t=${T},v0=${V1}`],
  ])("a malformed header: %s", (_name, header) => {
    expect(check({ header })).toEqual({ valid: false, reason: "malformed_header" });
  });

  it("a v1 that is not 64 lower-case hex digits matches nothing", () => {
    for (const bad of [V1.slice(0, 62), `${V1}00`, V1.toUpperCase(), "zz".repeat(32), ""]) {
      expect(check({ header: `t=${T},v1=${bad}` })).toEqual({ valid: false, reason: "no_matching_signature" });
    }
  });
});

describe("webhook signature: several v1 values", () => {
  const WRONG = "0".repeat(64);

  it("accepts when any of them matches, in any position", () => {
    expect(check({ header: `t=${T},v1=${WRONG},v1=${V1}` })).toEqual({ valid: true });
    expect(check({ header: `t=${T},v1=${V1},v1=${WRONG}` })).toEqual({ valid: true });
    expect(check({ header: `v1=${WRONG},t=${T},v1=${V1}` })).toEqual({ valid: true });
  });

  it("a malformed v1 next to a good one does not spoil the good one", () => {
    expect(check({ header: `t=${T},v1=nonsense,v1=${V1}` })).toEqual({ valid: true });
  });

  it("refuses when none matches", () => {
    expect(check({ header: `t=${T},v1=${WRONG},v1=${"f".repeat(64)}` })).toEqual({ valid: false, reason: "no_matching_signature" });
  });

  it("tolerates spaces after the commas and ignores keys of another scheme", () => {
    expect(check({ header: `t=${T}, v1=${V1}, v0=whatever` })).toEqual({ valid: true });
  });
});

describe("parseSignatureHeader", () => {
  it("returns the timestamp and the usable signatures", () => {
    const parsed = parseSignatureHeader(`t=${T},v1=${V1},v1=bad`);
    expect(parsed?.timestamp).toBe(T);
    expect(parsed?.signatures.map((signature) => signature.toString("hex"))).toEqual([V1]);
  });
});
