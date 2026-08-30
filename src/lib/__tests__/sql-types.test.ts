import { describe, expect, it } from "vitest";
import {
  baseSqlType,
  isBooleanSqlType,
  isExactNumericType,
  isLongTextSqlType,
  isNumericLiteral,
  isNumericSqlType,
  parseBooleanInput,
} from "../sql-types";

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

describe("consolidated predicate fixes the substring matcher it replaced", () => {
  // EditableCell used /int|decimal|numeric|float|double|real|bit/ against the
  // lowercased type, so "po·int" matched and YEAR did not.
  it("does not treat spatial types as numeric", () => {
    expect(isNumericSqlType("POINT")).toBe(false);
    expect(isNumericSqlType("MULTIPOINT")).toBe(false);
    expect(isNumericSqlType("GEOMETRY")).toBe(false);
  });

  it("does treat YEAR as numeric", () => {
    expect(isNumericSqlType("YEAR")).toBe(true);
  });
});

describe("isExactNumericType", () => {
  it("flags the types that cannot round-trip through a JS number", () => {
    for (const t of ["BIGINT", "BIGINT UNSIGNED", "DECIMAL(20,4)", "numeric"]) {
      expect(isExactNumericType(t), t).toBe(true);
    }
  });

  it("leaves types that fit in a double alone", () => {
    for (const t of ["INT", "SMALLINT", "FLOAT", "DOUBLE", "YEAR", "BIT"]) {
      expect(isExactNumericType(t), t).toBe(false);
    }
  });

  it("is a subset of isNumericSqlType", () => {
    for (const t of ["BIGINT", "DECIMAL(10,2)", "NUMERIC"]) {
      expect(isNumericSqlType(t), t).toBe(true);
    }
  });
});

describe("isBooleanSqlType", () => {
  it("matches only the boolean spellings", () => {
    for (const t of ["BOOL", "boolean", "TINYINT(1)"]) expect(isBooleanSqlType(t), t).toBe(true);
    for (const t of ["TINYINT", "TINYINT(4)", "INT", "BIT"]) {
      expect(isBooleanSqlType(t), t).toBe(false);
    }
  });
});

describe("isLongTextSqlType", () => {
  it("matches the wide types, on the base name", () => {
    for (const t of ["TEXT", "LONGTEXT", "mediumblob", "JSON", "BLOB"]) {
      expect(isLongTextSqlType(t), t).toBe(true);
    }
  });

  it("does not match on a substring", () => {
    // the old regex tested /text|blob|json/ anywhere in the string
    expect(isLongTextSqlType("VARCHAR(20)")).toBe(false);
    expect(isLongTextSqlType("INT")).toBe(false);
  });
});

describe("parseBooleanInput (#421)", () => {
  it("reads the spellings people type", () => {
    for (const yes of ["1", "true", "TRUE", "t", "yes", "Y", "on", " True "]) {
      expect(parseBooleanInput(yes)).toBe(1);
    }
    for (const no of ["0", "false", "FALSE", "f", "no", "N", "off", " false "]) {
      expect(parseBooleanInput(no)).toBe(0);
    }
  });

  it("refuses anything it cannot read, rather than guessing", () => {
    // Guessing is how this became a bug: MySQL takes a non-numeric string for
    // a TINYINT(1) and stores 0, so typing "true" silently set the column to
    // false — the opposite of what was asked for.
    for (const junk of ["banana", "2", "", "null", "-1", "truthy"]) {
      expect(parseBooleanInput(junk)).toBeUndefined();
    }
  });
});
