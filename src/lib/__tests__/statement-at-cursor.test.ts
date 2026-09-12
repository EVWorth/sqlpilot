import { describe, expect, it } from "vitest";
import { getStatementAtCursor } from "../statement-at-cursor";

const text = `
select * from job_search.scrape_log

select * from testing.alphabet

select * from broken
`.trim();

describe("getStatementAtCursor", () => {
  it("returns the first statement when cursor is on it", () => {
    const result = getStatementAtCursor(text, 1, 1);
    expect(result).toBe("select * from job_search.scrape_log");
  });

  it("returns the first statement when cursor is mid-line", () => {
    const result = getStatementAtCursor(text, 1, 15);
    expect(result).toBe("select * from job_search.scrape_log");
  });

  it("returns the second statement when cursor is on it", () => {
    const result = getStatementAtCursor(text, 3, 1);
    expect(result).toBe("select * from testing.alphabet");
  });

  it("returns the third statement when cursor is on it", () => {
    const result = getStatementAtCursor(text, 5, 1);
    expect(result).toBe("select * from broken");
  });

  it("handles single statement with no blank lines", () => {
    const result = getStatementAtCursor("select 1", 1, 1);
    expect(result).toBe("select 1");
  });

  it("handles semicolons as boundaries", () => {
    const sql = "select 1; select 2; select 3";
    expect(getStatementAtCursor(sql, 1, 1)).toBe("select 1;");
    expect(getStatementAtCursor(sql, 1, 12)).toBe("select 2;");
    expect(getStatementAtCursor(sql, 1, 24)).toBe("select 3");
  });

  it("handles mixed semicolons and blank lines", () => {
    const mixed = "select 1\n\nselect 2; select 3";
    expect(getStatementAtCursor(mixed, 1, 1)).toBe("select 1");
    expect(getStatementAtCursor(mixed, 3, 1)).toBe("select 2;");
    expect(getStatementAtCursor(mixed, 3, 15)).toBe("select 3");
  });

  it("handles multi-line statements", () => {
    const multi = "select *\nfrom users\nwhere id = 1";
    const result = getStatementAtCursor(multi, 2, 1);
    expect(result).toBe("select *\nfrom users\nwhere id = 1");
  });

  it("handles empty input", () => {
    expect(getStatementAtCursor("", 1, 1)).toBe("");
  });

  it("handles cursor at end of content with no trailing newline", () => {
    const result = getStatementAtCursor("select 1\n\nselect 2", 3, 9);
    expect(result).toBe("select 2");
  });

  it("handles statements separated only by blank lines", () => {
    const noSemicolons = "SELECT 1\n\nSELECT 2\n\nSELECT 3";
    expect(getStatementAtCursor(noSemicolons, 1, 1)).toBe("SELECT 1");
    expect(getStatementAtCursor(noSemicolons, 3, 1)).toBe("SELECT 2");
    expect(getStatementAtCursor(noSemicolons, 5, 1)).toBe("SELECT 3");
  });

  it("handles leading blank lines", () => {
    const leading = "\n\nSELECT 1";
    expect(getStatementAtCursor(leading, 3, 1)).toBe("SELECT 1");
  });

  describe("semicolons that are not boundaries", () => {
    it("does not split inside a string literal", () => {
      // The old backwards scan returned `select 'a` here, which is either a
      // syntax error or — worse — a fragment that still parses and runs.
      const sql = "select 'a;b' from orders;";
      expect(getStatementAtCursor(sql, 1, 1)).toBe(sql);
      expect(getStatementAtCursor(sql, 1, 20)).toBe(sql);
    });

    it("does not split inside a quoted identifier", () => {
      const sql = "select * from `odd;name`;";
      expect(getStatementAtCursor(sql, 1, 1)).toBe(sql);
    });

    it("does not split inside a line comment", () => {
      const sql = "select 1 -- why; not\nfrom dual;";
      expect(getStatementAtCursor(sql, 1, 1)).toBe(sql);
    });

    it("does not split inside a block comment", () => {
      const sql = "select 1 /* a; b */ from dual;";
      expect(getStatementAtCursor(sql, 1, 1)).toBe(sql);
    });

    it("keeps a routine body with its own semicolons in one piece", () => {
      const sql = [
        "DELIMITER $$",
        "CREATE PROCEDURE recalc()",
        "BEGIN",
        "  SET @a = 1;",
        "  SET @b = 2;",
        "END$$",
        "DELIMITER ;",
      ].join("\n");
      // Cursor on the first SET: the statement is the whole procedure, not
      // the one assignment.
      const result = getStatementAtCursor(sql, 4, 3);
      expect(result).toContain("CREATE PROCEDURE");
      expect(result).toContain("SET @b = 2;");
    });

    it("picks the right one when an earlier statement contains a semicolon", () => {
      const sql = "select ';' as x;\nselect 2;";
      expect(getStatementAtCursor(sql, 2, 3)).toBe("select 2;");
    });
  });

  it("returns the statement the cursor sits at the very end of", () => {
    // Where the cursor is the moment you finish typing one.
    const sql = "select 1;\nselect 2;";
    expect(getStatementAtCursor(sql, 1, 10)).toBe("select 1;");
  });

  it("falls back to the statement before the cursor when it is between two", () => {
    const sql = "select 1;\n\n\nselect 2;";
    expect(getStatementAtCursor(sql, 3, 1)).toBe("select 1;");
  });
});
