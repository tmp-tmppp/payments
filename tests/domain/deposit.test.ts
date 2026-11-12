import { describe, expect, it } from "vitest";
import {
  DEPOSIT_EXPIRY_MINUTES,
  DEPOSIT_FAILURE_REASONS,
  DEPOSIT_STATUSES,
  attachCheckoutSession,
  canDepositTransition,
  failDeposit,
  isDepositExpired,
  newDeposit,
  recordDepositCheck,
  succeedDeposit,
} from "../../src/domain/deposit.js";
import type { Deposit, DepositStatus } from "../../src/domain/deposit.js";
import { DomainError } from "../../src/domain/errors.js";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const LATER = new Date("2026-11-01T10:05:00.000Z");

const base = {
  id: "00000000-0000-7000-8000-000000000001",
  tenantId: "018f3c1e-7a00-7000-8000-0000000000aa",
  userId: "user-1",
  amount: 2500,
  idempotencyKey: "key-1",
  requestHash: "hash-1",
  now: NOW,
};

const pending = (): Deposit => newDeposit(base);
const succeeded = (): Deposit => succeedDeposit(pending(), LATER);
const failed = (): Deposit => failDeposit(pending(), "declined", LATER);

describe("newDeposit", () => {
  it("starts pending, expires 30 minutes after it was made and is first looked at then", () => {
    const deposit = pending();
    expect(deposit).toMatchObject({
      status: "pending",
      amount: 2500,
      providerSessionId: null,
      checkoutUrl: null,
      failureReason: null,
      checkAttempts: 0,
      lastError: null,
      completedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(DEPOSIT_EXPIRY_MINUTES).toBe(30);
    expect(deposit.expiresAt).toEqual(new Date("2026-11-01T10:30:00.000Z"));
    expect(deposit.nextCheckAt).toEqual(deposit.expiresAt);
  });

  it("refuses an invalid amount", () => {
    for (const amount of [0, -1, 1.5, 1_000_001, "5", null, undefined]) {
      expect(() => newDeposit({ ...base, amount })).toThrow(expect.objectContaining({ code: "invalid_amount" }));
    }
  });
});

describe("deposit transitions", () => {
  const legal: Array<[DepositStatus, DepositStatus]> = [
    ["pending", "succeeded"],
    ["pending", "failed"],
  ];

  it("allows exactly pending -> succeeded and pending -> failed", () => {
    for (const from of DEPOSIT_STATUSES) {
      for (const to of DEPOSIT_STATUSES) {
        expect(canDepositTransition(from, to), `${from} -> ${to}`).toBe(legal.some(([a, b]) => a === from && b === to));
      }
    }
  });

  it("succeeds: sets the end state and time, clears the job fields", () => {
    const deposit = succeedDeposit(recordDepositCheck(pending(), { at: LATER, error: "provider down" }, NOW), LATER);
    expect(deposit).toMatchObject({ status: "succeeded", failureReason: null, nextCheckAt: null, lastError: null, updatedAt: LATER, completedAt: LATER });
  });

  it.each(DEPOSIT_FAILURE_REASONS)("fails with reason %s", (reason) => {
    expect(failDeposit(pending(), reason, LATER)).toMatchObject({ status: "failed", failureReason: reason, nextCheckAt: null, completedAt: LATER });
  });

  it("does not change the deposit it was given", () => {
    const deposit = pending();
    succeedDeposit(deposit, LATER);
    failDeposit(deposit, "expired", LATER);
    expect(deposit.status).toBe("pending");
  });

  it.each([
    ["succeed a succeeded deposit", () => succeedDeposit(succeeded(), LATER)],
    ["fail a succeeded deposit", () => failDeposit(succeeded(), "expired", LATER)],
    ["succeed a failed deposit", () => succeedDeposit(failed(), LATER)],
    ["fail a failed deposit", () => failDeposit(failed(), "expired", LATER)],
  ])("refuses to %s", (_label, run) => {
    expect(run).toThrow(DomainError);
    expect(run).toThrow(expect.objectContaining({ code: "illegal_transition" }));
  });
});

describe("attachCheckoutSession", () => {
  const session = { id: "cs_abc", url: "https://pay.example/checkout/cs_abc" };

  it("stores the session of the provider on a pending deposit", () => {
    expect(attachCheckoutSession(pending(), session, LATER)).toMatchObject({ providerSessionId: "cs_abc", checkoutUrl: session.url, updatedAt: LATER, status: "pending" });
  });

  it("refuses a second session and a session on an ended deposit", () => {
    expect(() => attachCheckoutSession(attachCheckoutSession(pending(), session, LATER), session, LATER)).toThrow(/already has a checkout session/);
    expect(() => attachCheckoutSession(succeeded(), session, LATER)).toThrow(/succeeded deposit cannot get/);
    expect(() => attachCheckoutSession(failed(), session, LATER)).toThrow(DomainError);
  });
});

describe("recordDepositCheck", () => {
  it("counts the failed look and moves the next one", () => {
    const next = new Date("2026-11-01T10:31:00.000Z");
    const once = recordDepositCheck(pending(), { at: next, error: "timeout" }, LATER);
    const twice = recordDepositCheck(once, { at: new Date(next.getTime() + 60_000), error: "503" }, LATER);
    expect(once).toMatchObject({ checkAttempts: 1, nextCheckAt: next, lastError: "timeout", status: "pending" });
    expect(twice).toMatchObject({ checkAttempts: 2, lastError: "503" });
  });

  it("keeps a storable last error (NUL and a lone surrogate become U+FFFD, at most 500 units) and keeps null as null", () => {
    expect(recordDepositCheck(pending(), { at: LATER, error: `\u0000${"y".repeat(600)}` }, LATER).lastError).toBe(`�${"y".repeat(499)}`);
    expect(recordDepositCheck(pending(), { at: LATER, error: "half \udbff" }, LATER).lastError).toBe("half �");
    expect(recordDepositCheck(pending(), { at: LATER, error: null }, LATER).lastError).toBeNull();
  });

  it("refuses an ended deposit", () => {
    expect(() => recordDepositCheck(succeeded(), { at: LATER, error: "x" }, LATER)).toThrow(expect.objectContaining({ code: "illegal_transition" }));
    expect(() => recordDepositCheck(failed(), { at: LATER, error: "x" }, LATER)).toThrow(DomainError);
  });
});

describe("isDepositExpired", () => {
  it("is true for a pending deposit from its 30th minute on", () => {
    const deposit = pending();
    expect(isDepositExpired(deposit, new Date("2026-11-01T10:29:59.999Z"))).toBe(false);
    expect(isDepositExpired(deposit, new Date("2026-11-01T10:30:00.000Z"))).toBe(true);
    expect(isDepositExpired(deposit, new Date("2026-11-02T10:00:00.000Z"))).toBe(true);
  });

  it("is false once the deposit ended", () => {
    const late = new Date("2026-11-02T10:00:00.000Z");
    expect(isDepositExpired(succeeded(), late)).toBe(false);
    expect(isDepositExpired(failed(), late)).toBe(false);
  });
});
