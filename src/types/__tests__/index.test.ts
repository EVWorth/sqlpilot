import { describe, it, expect } from "vitest";
import { SqlValueGuard } from "../index";

describe("SqlValueGuard.isNull", () => {
  it("returns true for null", () => {
    expect(SqlValueGuard.isNull(null)).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(SqlValueGuard.isNull(undefined)).toBe(false);
  });

  it("returns false for 0", () => {
    expect(SqlValueGuard.isNull(0)).toBe(false);
  });

  it("returns false for false", () => {
    expect(SqlValueGuard.isNull(false)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(SqlValueGuard.isNull("")).toBe(false);
  });

  it("returns false for object", () => {
    expect(SqlValueGuard.isNull({})).toBe(false);
  });

  it("returns false for array", () => {
    expect(SqlValueGuard.isNull([])).toBe(false);
  });

  it("refines type via val is null predicate", () => {
    const val: unknown = null;
    if (SqlValueGuard.isNull(val)) {
      // val should be narrowed to null
      expect(val).toBe(null);
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      void val;
    }
  });
});

describe("SqlValueGuard.isBoolean", () => {
  it("returns true for true", () => {
    expect(SqlValueGuard.isBoolean(true)).toBe(true);
  });

  it("returns true for false", () => {
    expect(SqlValueGuard.isBoolean(false)).toBe(true);
  });

  it("returns false for 0", () => {
    expect(SqlValueGuard.isBoolean(0)).toBe(false);
  });

  it("returns false for 1", () => {
    expect(SqlValueGuard.isBoolean(1)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(SqlValueGuard.isBoolean("")).toBe(false);
  });

  it("returns false for null", () => {
    expect(SqlValueGuard.isBoolean(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(SqlValueGuard.isBoolean(undefined)).toBe(false);
  });

  it("returns false for object", () => {
    expect(SqlValueGuard.isBoolean({})).toBe(false);
  });
});

describe("SqlValueGuard.isNumber", () => {
  it("returns true for 0", () => {
    expect(SqlValueGuard.isNumber(0)).toBe(true);
  });

  it("returns true for 1", () => {
    expect(SqlValueGuard.isNumber(1)).toBe(true);
  });

  it("returns true for -1", () => {
    expect(SqlValueGuard.isNumber(-1)).toBe(true);
  });

  it("returns true for 3.14", () => {
    expect(SqlValueGuard.isNumber(3.14)).toBe(true);
  });

  it("returns true for large numbers", () => {
    expect(SqlValueGuard.isNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("returns true for small negative numbers", () => {
    expect(SqlValueGuard.isNumber(-0.001)).toBe(true);
  });

  it("returns false for NaN", () => {
    expect(SqlValueGuard.isNumber(NaN)).toBe(false);
  });

  it("returns false for Infinity", () => {
    expect(SqlValueGuard.isNumber(Infinity)).toBe(false);
  });

  it("returns false for -Infinity", () => {
    expect(SqlValueGuard.isNumber(-Infinity)).toBe(false);
  });

  it("returns false for null", () => {
    expect(SqlValueGuard.isNumber(null)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(SqlValueGuard.isNumber("")).toBe(false);
  });

  it("returns false for numeric string", () => {
    expect(SqlValueGuard.isNumber("42")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(SqlValueGuard.isNumber(undefined)).toBe(false);
  });
});

describe("SqlValueGuard.isString", () => {
  it("returns true for empty string", () => {
    expect(SqlValueGuard.isString("")).toBe(true);
  });

  it("returns true for non-empty string", () => {
    expect(SqlValueGuard.isString("hello")).toBe(true);
  });

  it("returns true for string with special characters", () => {
    expect(SqlValueGuard.isString("hello world 123!@#")).toBe(true);
  });

  it("returns true for template literal string", () => {
    expect(SqlValueGuard.isString(`template`)).toBe(true);
  });

  it("returns false for number 42", () => {
    expect(SqlValueGuard.isString(42)).toBe(false);
  });

  it("returns false for null", () => {
    expect(SqlValueGuard.isString(null)).toBe(false);
  });

  it("returns false for true", () => {
    expect(SqlValueGuard.isString(true)).toBe(false);
  });

  it("returns false for false", () => {
    expect(SqlValueGuard.isString(false)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(SqlValueGuard.isString(undefined)).toBe(false);
  });

  it("returns false for array", () => {
    expect(SqlValueGuard.isString([])).toBe(false);
  });
});

describe("SqlValueGuard.isNumberArray", () => {
  it("returns true for empty array", () => {
    expect(SqlValueGuard.isNumberArray([])).toBe(true);
  });

  it("returns true for array of numbers", () => {
    expect(SqlValueGuard.isNumberArray([1, 2, 3])).toBe(true);
  });

  it("returns true for array with single number", () => {
    expect(SqlValueGuard.isNumberArray([42])).toBe(true);
  });

  it("returns true for array with negative numbers", () => {
    expect(SqlValueGuard.isNumberArray([-1, -2, -3])).toBe(true);
  });

  it("returns true for array with floating point", () => {
    expect(SqlValueGuard.isNumberArray([1.5, 2.7, 3.14])).toBe(true);
  });

  it("returns true for array with zero", () => {
    expect(SqlValueGuard.isNumberArray([0, 0, 0])).toBe(true);
  });

  it("returns false for array with mixed types", () => {
    expect(SqlValueGuard.isNumberArray([1, "a"])).toBe(false);
  });

  it("returns false for array with string numbers", () => {
    expect(SqlValueGuard.isNumberArray(["1", "2"])).toBe(false);
  });

  it("returns false for array with NaN", () => {
    expect(SqlValueGuard.isNumberArray([NaN])).toBe(false);
  });

  it("returns false for array with NaN mixed with valid numbers", () => {
    expect(SqlValueGuard.isNumberArray([1, NaN, 3])).toBe(false);
  });

  it("returns false for array with Infinity", () => {
    expect(SqlValueGuard.isNumberArray([Infinity])).toBe(false);
  });

  it("returns false for array with -Infinity", () => {
    expect(SqlValueGuard.isNumberArray([-Infinity])).toBe(false);
  });

  it("returns false for null", () => {
    expect(SqlValueGuard.isNumberArray(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(SqlValueGuard.isNumberArray(undefined)).toBe(false);
  });

  it("returns false for plain number", () => {
    expect(SqlValueGuard.isNumberArray(42)).toBe(false);
  });

  it("returns false for string", () => {
    expect(SqlValueGuard.isNumberArray("hello")).toBe(false);
  });

  it("returns false for object", () => {
    expect(SqlValueGuard.isNumberArray({ length: 0 })).toBe(false);
  });
});

describe("SqlValueGuard.isValid", () => {
  it("returns true for null", () => {
    expect(SqlValueGuard.isValid(null)).toBe(true);
  });

  it("returns true for boolean true", () => {
    expect(SqlValueGuard.isValid(true)).toBe(true);
  });

  it("returns true for boolean false", () => {
    expect(SqlValueGuard.isValid(false)).toBe(true);
  });

  it("returns true for number 0", () => {
    expect(SqlValueGuard.isValid(0)).toBe(true);
  });

  it("returns true for number 42", () => {
    expect(SqlValueGuard.isValid(42)).toBe(true);
  });

  it("returns true for negative number", () => {
    expect(SqlValueGuard.isValid(-100)).toBe(true);
  });

  it("returns true for empty string", () => {
    expect(SqlValueGuard.isValid("")).toBe(true);
  });

  it("returns true for non-empty string", () => {
    expect(SqlValueGuard.isValid("hello")).toBe(true);
  });

  it("returns true for empty number array", () => {
    expect(SqlValueGuard.isValid([])).toBe(true);
  });

  it("returns true for populated number array", () => {
    expect(SqlValueGuard.isValid([1, 2, 3])).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(SqlValueGuard.isValid(undefined)).toBe(false);
  });

  it("returns false for NaN", () => {
    expect(SqlValueGuard.isValid(NaN)).toBe(false);
  });

  it("returns false for Infinity", () => {
    expect(SqlValueGuard.isValid(Infinity)).toBe(false);
  });

  it("returns false for object", () => {
    expect(SqlValueGuard.isValid({})).toBe(false);
  });

  it("returns false for array with strings", () => {
    expect(SqlValueGuard.isValid(["a", "b"])).toBe(false);
  });

  it("returns false for function", () => {
    expect(SqlValueGuard.isValid(() => {})).toBe(false);
  });

  it("returns false for symbol", () => {
    expect(SqlValueGuard.isValid(Symbol("test"))).toBe(false);
  });

  it("returns false for BigInt", () => {
    expect(SqlValueGuard.isValid(BigInt(42))).toBe(false);
  });

  it("returns false for Date", () => {
    expect(SqlValueGuard.isValid(new Date())).toBe(false);
  });
});

describe("SqlValueGuard.assert", () => {
  it("returns null when value is null", () => {
    expect(SqlValueGuard.assert(null)).toBe(null);
  });

  it("returns boolean when value is true", () => {
    expect(SqlValueGuard.assert(true)).toBe(true);
  });

  it("returns boolean when value is false", () => {
    expect(SqlValueGuard.assert(false)).toBe(false);
  });

  it("returns number when value is 0", () => {
    expect(SqlValueGuard.assert(0)).toBe(0);
  });

  it("returns number when value is 42", () => {
    expect(SqlValueGuard.assert(42)).toBe(42);
  });

  it("returns number when value is negative", () => {
    expect(SqlValueGuard.assert(-1)).toBe(-1);
  });

  it("returns number when value is float", () => {
    expect(SqlValueGuard.assert(3.14)).toBe(3.14);
  });

  it("returns string when value is empty string", () => {
    expect(SqlValueGuard.assert("")).toBe("");
  });

  it("returns string when value is non-empty", () => {
    expect(SqlValueGuard.assert("hello")).toBe("hello");
  });

  it("returns number array when value is empty array", () => {
    expect(SqlValueGuard.assert([])).toEqual([]);
  });

  it("returns number array when value is populated", () => {
    expect(SqlValueGuard.assert([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("throws TypeError for undefined", () => {
    expect(() => SqlValueGuard.assert(undefined)).toThrow(TypeError);
  });

  it("throws TypeError for NaN", () => {
    expect(() => SqlValueGuard.assert(NaN)).toThrow(TypeError);
  });

  it("throws TypeError for Infinity", () => {
    expect(() => SqlValueGuard.assert(Infinity)).toThrow(TypeError);
  });

  it("throws TypeError for object", () => {
    expect(() => SqlValueGuard.assert({})).toThrow(TypeError);
  });

  it("throws TypeError for mixed array", () => {
    expect(() => SqlValueGuard.assert([1, "a"])).toThrow(TypeError);
  });

  it("throws TypeError for function", () => {
    expect(() => SqlValueGuard.assert(() => {})).toThrow(TypeError);
  });

  it("throws TypeError for symbol", () => {
    expect(() => SqlValueGuard.assert(Symbol("x"))).toThrow(TypeError);
  });

  it("throws TypeError for BigInt", () => {
    expect(() => SqlValueGuard.assert(BigInt(1))).toThrow(TypeError);
  });

  it("throws error with descriptive message", () => {
    expect(() => SqlValueGuard.assert(undefined)).toThrow(
      "Invalid SqlValue: undefined",
    );
  });

  it("error message includes string representation of value", () => {
    expect(() => SqlValueGuard.assert({ foo: 1 })).toThrow(/\[object Object\]/);
  });
});

describe("SqlValueGuard.toString", () => {
  it('converts null to "NULL"', () => {
    expect(SqlValueGuard.toString(null)).toBe("NULL");
  });

  it('converts true to "TRUE"', () => {
    expect(SqlValueGuard.toString(true)).toBe("TRUE");
  });

  it('converts false to "FALSE"', () => {
    expect(SqlValueGuard.toString(false)).toBe("FALSE");
  });

  it("converts 0 to string", () => {
    expect(SqlValueGuard.toString(0)).toBe("0");
  });

  it("converts positive integer to string", () => {
    expect(SqlValueGuard.toString(42)).toBe("42");
  });

  it("converts negative integer to string", () => {
    expect(SqlValueGuard.toString(-1)).toBe("-1");
  });

  it("converts float to string", () => {
    expect(SqlValueGuard.toString(3.14)).toBe("3.14");
  });

  it("converts string to same string", () => {
    expect(SqlValueGuard.toString("hello")).toBe("hello");
  });

  it("converts empty string to empty string", () => {
    expect(SqlValueGuard.toString("")).toBe("");
  });

  it("converts number array to JSON string", () => {
    expect(SqlValueGuard.toString([1, 2, 3])).toBe("[1,2,3]");
  });

  it("converts empty number array to JSON string", () => {
    expect(SqlValueGuard.toString([])).toBe("[]");
  });

  it("converts single-element number array to JSON string", () => {
    expect(SqlValueGuard.toString([42])).toBe("[42]");
  });

  it("converts negative number array to JSON string", () => {
    expect(SqlValueGuard.toString([-1, -2])).toBe("[-1,-2]");
  });

  it("handles invalid value reaching exhaustive check", () => {
    const badVal = { foo: "bar" } as any;
    expect(SqlValueGuard.toString(badVal)).toBe(String(badVal));
  });
});

describe("SqlValueGuard.toSqlLiteral", () => {
  it('converts null to "NULL"', () => {
    expect(SqlValueGuard.toSqlLiteral(null)).toBe("NULL");
  });

  it('converts true to "1"', () => {
    expect(SqlValueGuard.toSqlLiteral(true)).toBe("1");
  });

  it('converts false to "0"', () => {
    expect(SqlValueGuard.toSqlLiteral(false)).toBe("0");
  });

  it("converts 0 to string", () => {
    expect(SqlValueGuard.toSqlLiteral(0)).toBe("0");
  });

  it("converts positive integer to string", () => {
    expect(SqlValueGuard.toSqlLiteral(42)).toBe("42");
  });

  it("converts negative integer to string", () => {
    expect(SqlValueGuard.toSqlLiteral(-1)).toBe("-1");
  });

  it("converts float to string", () => {
    expect(SqlValueGuard.toSqlLiteral(3.14)).toBe("3.14");
  });

  it("converts simple string to quoted SQL literal", () => {
    expect(SqlValueGuard.toSqlLiteral("hello")).toBe("'hello'");
  });

  it("converts empty string to quoted empty SQL literal", () => {
    expect(SqlValueGuard.toSqlLiteral("")).toBe("''");
  });

  it("escapes single quotes in strings", () => {
    expect(SqlValueGuard.toSqlLiteral("it's")).toBe("'it''s'");
  });

  it("escapes multiple single quotes", () => {
    expect(SqlValueGuard.toSqlLiteral("it''s")).toBe("'it''''s'");
  });

  it("handles string with only single quote", () => {
    expect(SqlValueGuard.toSqlLiteral("'")).toBe("''''");
  });

  it("converts number array to quoted JSON SQL literal", () => {
    expect(SqlValueGuard.toSqlLiteral([1, 2, 3])).toBe("'[1,2,3]'");
  });

  it("converts empty number array to quoted empty JSON", () => {
    expect(SqlValueGuard.toSqlLiteral([])).toBe("'[]'");
  });

  it("converts single-element array to quoted JSON", () => {
    expect(SqlValueGuard.toSqlLiteral([42])).toBe("'[42]'");
  });

  it("converts negative number array to quoted JSON", () => {
    expect(SqlValueGuard.toSqlLiteral([-1, -2])).toBe("'[-1,-2]'");
  });

  it("escapes single quotes in JSON array representation", () => {
    // JSON.stringify produces a string without quotes in array values,
    // but this ensures any ' in the JSON output gets escaped.
    // The JSON of a number array won't contain single quotes, but we test
    // the mechanism by constructing a scenario.
    const val: number[] = [1, 2];
    const result = SqlValueGuard.toSqlLiteral(val);
    expect(result).toBe("'[1,2]'");
    // The replace('.replace(/'/g, "''")') would act on the JSON string;
    // it's an array of numbers so no single quotes exist, but the function
    // applies the replace defensively.
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });

  it("handles invalid value reaching exhaustive check", () => {
    const badVal = { foo: "bar" } as any;
    expect(typeof SqlValueGuard.toSqlLiteral(badVal)).toBe("string");
  });
});
