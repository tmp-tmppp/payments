import { describe, expect, it } from "vitest";
import { AMOUNT_MAX, AMOUNT_MIN, CURRENCY, isValidAmount, parseAmount } from "../../src/domain/amount.js";
import { DomainError } from "../../src/domain/errors.js";

describe("amount", () => {
  it("is one integer of credits = EUR cents, from 1 to 1 000 000, in EUR", () => {
    expect(AMOUNT_MIN).toBe(1);
    expect(AMOUNT_MAX).toBe(1_000_000);
    expect(CURRENCY).toBe("EUR");
  });

  it.each([1, 2, 500, 999_999, 1_000_000])("accepts %s", (value) => {
    expect(isValidAmount(value)).toBe(true);
    expect(parseAmount(value)).toBe(value);
  });

  it.each([
    ["zero", 0],
    ["a negative", -5],
    ["a fraction", 1.5],
    ["one above the maximum", 1_000_001],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", 2 ** 60],
    ["a string", "100"],
    ["a boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["an object", { amount: 100 }],
  ])("refuses %s with a DomainError that names the field", (_label, value) => {
    expect(isValidAmount(value)).toBe(false);
    expect(() => parseAmount(value)).toThrow(DomainError);
    try {
      parseAmount(value, "amount");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_amount", field: "amount" });
    }
  });

  it("names another field when asked to", () => {
    expect(() => parseAmount(0, "total")).toThrow(/total must be an integer from 1 to 1000000/);
  });
});
