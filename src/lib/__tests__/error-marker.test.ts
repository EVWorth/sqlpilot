import { describe, expect, it } from "vitest";
import { statementRange } from "../error-marker";

describe("statementRange (#845)", () => {
  it("finds the statement on its own line", () => {
    const text = "SELECT * FROM products;\nSELECT * FROM nope;\nSELECT 1;";
    expect(statementRange(text, "SELECT * FROM nope")).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 19,
    });
  });

  it("spans lines", () => {
    expect(statementRange("SELECT 1;\n  SELECT *\n  FROM t;", "SELECT *\n  FROM t")).toEqual({
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 3,
      endColumn: 9,
    });
  });

  it("is null when the statement is not in the text", () => {
    expect(statementRange("SELECT 1", "SELECT 2")).toBeNull();
    expect(statementRange("SELECT 1", "  ")).toBeNull();
  });
});
