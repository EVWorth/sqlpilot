import { describe, expect, it } from "vitest";
import { baseSqlType, isNumericLiteral, isNumericSqlType } from "../sql-types";

describe("baseSqlType", () => {
  it("strips precision and scale", () => {
    expect(baseSqlType("DECIMAL(20,4)")).toBe("DECIMAL");
    expect(baseSqlType("varchar(255)")).toBe("VARCHAR");
  });

  it("strips UNSIGNED and ZEROFILL", () => {
    expect(baseSqlType("BIGINT UNSIGNED")).toBe("BIGINT");
    expect(baseSqlType("INT UNSIGNED ZEROFILL")).toBe("INT");
  });

  it("upper-cases", () => {
    expect(baseSqlType("bigint")).toBe("BIGINT");
  });
});

describe("isNumericSqlType", () => {
  it("recognises the numeric types, including the stringified ones", () => {
    for (const t of ["BIGINT", "BIGINT UNSIGNED", "DECIMAL(20,4)", "int", "YEAR", "BIT", "FLOAT"]) {
      expect(isNumericSqlType(t), t).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const t of ["VARCHAR(20)", "TEXT", "JSON", "DATETIME", "BLOB", "ENUM"]) {
      expect(isNumericSqlType(t), t).toBe(false);
    }
  });

  it("is false when the type is unknown", () => {
    expect(isNumericSqlType(undefined)).toBe(false);
  });
});

describe("isNumericLiteral", () => {
  it("accepts numbers the server can send", () => {
    for (const v of ["0", "42", "-1", "9007199254740993", "12345678901234.5678", ".5", "1e10", "-2.5E-3"]) {
      expect(isNumericLiteral(v), v).toBe(true);
    }
  });

  it("rejects anything that is not purely a number", () => {
    // This is the guard that stops text being spliced into SQL unquoted if a
    // column's declared type and its value ever disagree.
    for (const v of ["", "abc", "1; DROP TABLE users", "1 OR 1=1", "0x10", "NaN", " 1 2 "]) {
      expect(isNumericLiteral(v), v).toBe(false);
    }
  });
});
