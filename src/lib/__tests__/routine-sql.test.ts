import { describe, expect, it } from "vitest";
import { buildDropRoutine, buildFunctionCall, formatParamValue, isPlainIdentifier } from "../routine-sql";

describe("formatParamValue", () => {
  describe("string parameters", () => {
    it("does not let a backslash-quote escape the literal", () => {
      // The old escape replaced ' with \' and left backslashes alone, so this
      // input produced  '\\' OR 1=1 -- '  — the one-character string \ then
      // live SQL. Confirmed against MySQL 8: the injected predicate runs.
      const out = formatParamValue("\\' OR 1=1 -- ", "VARCHAR(50)");
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.sql).toBe("'\\\\\\' OR 1=1 -- '");
      // Every backslash the input carried is doubled, so nothing it contains
      // is read as an escape.
      expect(out.sql.startsWith("'\\\\")).toBe(true);
    });

    it("escapes a lone backslash, which used to leave the string unterminated", () => {
      const out = formatParamValue("C:\\temp", "TEXT");
      expect(out.ok && out.sql).toBe("'C:\\\\temp'");
    });

    it("keeps an ordinary value intact", () => {
      const out = formatParamValue("O'Brien", "VARCHAR(20)");
      expect(out.ok && out.sql).toBe("'O\\'Brien'");
    });
  });

  describe("numeric parameters", () => {
    it("passes a plain number through unquoted", () => {
      expect(formatParamValue("42", "INT")).toEqual({ ok: true, sql: "42" });
    });

    it("refuses text rather than letting MySQL coerce it to zero", () => {
      // MySQL accepts 'abc' for an INT and silently makes it 0, so the routine
      // would run with a value the user never typed — the same silent-wrong
      // -value failure as the boolean cell in #421.
      const out = formatParamValue("abc", "INT");
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toContain("not a valid INT");
    });

    it("refuses a value that overflows to Infinity", () => {
      // Number("1e999") is Infinity, and String(Infinity) is "Infinity" —
      // not a number, and not what was typed.
      expect(formatParamValue("1e999", "DOUBLE").ok).toBe(false);
    });

    it("keeps BIGINT digits as text so the last one survives", () => {
      // Number() would round 9007199254740993 to ...992.
      expect(formatParamValue("9007199254740993", "BIGINT")).toEqual({
        ok: true,
        sql: "9007199254740993",
      });
    });

    it("keeps DECIMAL exact", () => {
      expect(formatParamValue("0.10", "DECIMAL(10,2)")).toEqual({ ok: true, sql: "0.10" });
    });

    it("refuses a malformed exact numeric", () => {
      expect(formatParamValue("1; DROP TABLE t", "BIGINT").ok).toBe(false);
    });

    it("refuses an empty numeric rather than sending nothing", () => {
      expect(formatParamValue("   ", "INT").ok).toBe(false);
    });
  });
});

describe("buildDropRoutine", () => {
  it("quotes both identifiers", () => {
    expect(buildDropRoutine("PROCEDURE", "app", "sp_test")).toBe(
      "DROP PROCEDURE `app`.`sp_test`",
    );
  });

  it("doubles a backtick in a name instead of ending the quoting", () => {
    expect(buildDropRoutine("FUNCTION", "app", "we`ird")).toBe(
      "DROP FUNCTION `app`.`we``ird`",
    );
  });
});

describe("buildFunctionCall", () => {
  it("quotes the identifiers and passes the args through", () => {
    expect(buildFunctionCall("app", "fn_add", ["1", "'x'"])).toBe(
      "SELECT `app`.`fn_add`(1, 'x') AS `result`",
    );
  });
});

describe("isPlainIdentifier", () => {
  it("accepts what a routine declaration can name a parameter", () => {
    for (const name of ["x", "_p", "p1", "$v", "someName"]) {
      expect(isPlainIdentifier(name)).toBe(true);
    }
  });

  it("rejects anything that would change the meaning of SET @name", () => {
    for (const name of ["a b", "a`b", "a'b", "1a", "", "a;DROP"]) {
      expect(isPlainIdentifier(name)).toBe(false);
    }
  });
});
