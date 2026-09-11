import { describe, expect, it } from "vitest";
import type { FormatterSettings } from "../../stores/settingsStore";
import { formatSql, PREVIEW_SQL } from "../sql-format";

const settings = (over: Partial<FormatterSettings> = {}): FormatterSettings => ({
  keywordCase: "upper",
  identifierCase: "preserve",
  dataTypeCase: "upper",
  functionCase: "preserve",
  indentStyle: "standard",
  tabWidth: 2,
  useTabs: false,
  logicalOperatorNewline: "before",
  newlineBeforeSemicolon: false,
  expressionWidth: 50,
  linesBetweenQueries: 1,
  denseOperators: false,
  ...over,
});

describe("sql-format (#355)", () => {
  it("applies keyword case", () => {
    expect(formatSql("select 1", settings({ keywordCase: "upper" }))).toContain("SELECT");
    expect(formatSql("SELECT 1", settings({ keywordCase: "lower" }))).toContain("select");
  });

  it("applies indentation width", () => {
    const wide = formatSql("select a, b from t", settings({ tabWidth: 8 }));
    const narrow = formatSql("select a, b from t", settings({ tabWidth: 2 }));
    expect(wide).not.toBe(narrow);
  });

  it("uses tabs when asked", () => {
    expect(formatSql("select a, b from t", settings({ useTabs: true }))).toContain("\t");
  });

  it.each([
    ["an unterminated string", "SELECT 'unterminated"],
    ["unbalanced parentheses", "((("],
  ])("hands back %s rather than destroying it", (_name, sql) => {
    // Half-written statements are the normal case while typing, and
    // sql-formatter throws on these. Returning the input is the only sensible
    // answer; the alternative is losing what the user was working on.
    expect(formatSql(sql, settings())).toBe(sql);
  });

  it("leaves an empty input empty", () => {
    expect(formatSql("", settings())).toBe("");
  });

  it("has a sample that formats", () => {
    // The dialog falls back to it, so it has to survive the formatter.
    const formatted = formatSql(PREVIEW_SQL, settings({ keywordCase: "upper" }));
    expect(formatted).toContain("SELECT");
    expect(formatted).toContain("LEFT JOIN");
  });
});
