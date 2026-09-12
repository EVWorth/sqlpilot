import { describe, expect, it } from "vitest";
import { POOL_MAX_LIMIT, validatePoolSizing } from "../connection-validation";

describe("pool sizing (#279)", () => {
  it("accepts the ordinary values", () => {
    expect(validatePoolSizing(1, 5)).toEqual({});
    expect(validatePoolSizing(0, 1)).toEqual({});
    expect(validatePoolSizing(5, POOL_MAX_LIMIT)).toEqual({});
  });

  it("refuses a maximum of zero", () => {
    // sqlx panics on a zero-max pool.
    expect(validatePoolSizing(0, 0).max).toContain("At least one");
  });

  it("refuses more than the ceiling, and says why it exists", () => {
    const problems = validatePoolSizing(1, 5000);
    expect(problems.max).toContain(String(POOL_MAX_LIMIT));
    expect(problems.max).toContain("server thread");
  });

  it("refuses a minimum above the maximum", () => {
    // sqlx refuses to build such a pool at all.
    expect(validatePoolSizing(20, 5).min).toContain("5");
  });

  it("says nothing about the minimum when the maximum is the thing that is wrong", () => {
    // "cannot be more than the maximum (0)" beside "0 is not a maximum" is
    // two complaints about one mistake.
    const problems = validatePoolSizing(3, 0);
    expect(problems.max).toBeDefined();
    expect(problems.min).toBeUndefined();
  });

  it("refuses a negative minimum and explains what zero means", () => {
    expect(validatePoolSizing(-1, 5).min).toContain("0 to open connections only as they are needed");
  });

  it("refuses a value that is not a whole number", () => {
    // What an empty or half-typed field parses to.
    expect(validatePoolSizing(1, Number.NaN).max).toBeDefined();
    expect(validatePoolSizing(Number.NaN, 5).min).toBeDefined();
  });

  it("agrees with the ceiling the backend clamps to", () => {
    // If these drift, the dialog refuses a value the backend would accept, or
    // accepts one it silently changes.
    expect(POOL_MAX_LIMIT).toBe(50);
  });
});
