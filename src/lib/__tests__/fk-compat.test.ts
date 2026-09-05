import { describe, expect, it } from "vitest";
import { foreignKeyTypeProblem } from "../fk-compat";

describe("foreignKeyTypeProblem", () => {
  it("names the mismatch MySQL would reject", () => {
    // MySQL answers this with ERROR 1215, which says nothing about which
    // column or why (#385).
    const problem = foreignKeyTypeProblem("VARCHAR(50)", "INT");
    expect(problem).toContain("VARCHAR(50)");
    expect(problem).toContain("INT");
  });

  it("is quiet about widths within a family, which MySQL accepts", () => {
    expect(foreignKeyTypeProblem("INT", "BIGINT")).toBeNull();
    expect(foreignKeyTypeProblem("VARCHAR(50)", "VARCHAR(255)")).toBeNull();
    expect(foreignKeyTypeProblem("CHAR(10)", "VARCHAR(10)")).toBeNull();
  });

  it("separates the families that do not mix", () => {
    expect(foreignKeyTypeProblem("INT", "VARCHAR(10)")).not.toBeNull();
    expect(foreignKeyTypeProblem("DATE", "INT")).not.toBeNull();
    expect(foreignKeyTypeProblem("VARBINARY(16)", "VARCHAR(16)")).not.toBeNull();
    expect(foreignKeyTypeProblem("DECIMAL(10,2)", "INT")).not.toBeNull();
  });

  it("says nothing about a type it does not recognise", () => {
    // A guess would be worse than silence: refusing more than the server
    // does is the failure mode to avoid.
    expect(foreignKeyTypeProblem("GEOMETRY", "INT")).toBeNull();
    expect(foreignKeyTypeProblem("INT", "SOMETHING_NEW")).toBeNull();
  });

  it("says nothing when either side is not chosen yet", () => {
    expect(foreignKeyTypeProblem(undefined, "INT")).toBeNull();
    expect(foreignKeyTypeProblem("INT", undefined)).toBeNull();
  });

  it("ignores UNSIGNED and the like when deciding the family", () => {
    expect(foreignKeyTypeProblem("INT UNSIGNED", "BIGINT")).toBeNull();
  });
});
