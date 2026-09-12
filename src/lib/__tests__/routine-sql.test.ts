import { describe, expect, it } from "vitest";
import {
  buildDropRoutine,
  buildFunctionCall,
  buildProcedureBatch,
  formatParamValue,
  isPlainIdentifier,
  paramVariable,
  validateParams,
} from "../routine-sql";

describe("formatParamValue", () => {
  describe("string parameters", () => {
    it("does not let a backslash-quote escape the literal", () => {
      // The old escape replaced ' with \' and left backslashes alone, so this
      // input produced  '\\' OR 1=1 -- '  — the one-character string \ then
      // live SQL. Confirmed against MySQL 8: the injected predicate runs.
      const out = formatParamValue("\\' OR 1=1 -- ", "VARCHAR(50)");
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.sql).toBe("'\\\\'' OR 1=1 -- '");
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
      expect(out.ok && out.sql).toBe("'O''Brien'");
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

describe("session variables for parameters (#394)", () => {
  it("namespaces them, so a call cannot clobber the user's own", () => {
    // The connection is shared with the editor: calling a procedure whose
    // parameter is `x` used to overwrite whatever was in `@x`, with nothing
    // in the editor to say it had happened.
    expect(paramVariable("x")).toBe("@sqlpilot_param_x");
    expect(paramVariable("x")).not.toBe("@x");
  });

  it("gives two parameters two variables", () => {
    expect(paramVariable("a")).not.toBe(paramVariable("b"));
  });
});

describe("validating parameters as they are typed (#398)", () => {
  const params = [
    { name: "count", direction: "IN", dataType: "INT" },
    { name: "label", direction: "IN", dataType: "VARCHAR(64)" },
    { name: "result", direction: "OUT", dataType: "INT" },
  ];

  it("finds nothing wrong with values that can be sent", () => {
    expect(validateParams(params, { count: "42", label: "anything at all" })).toEqual({});
  });

  it("names the parameter and says what is wrong with it", () => {
    const problems = validateParams(params, { count: "123abc" });
    expect(Object.keys(problems)).toEqual(["count"]);
    expect(problems.count).toContain("INT");
  });

  it("treats an empty value as NULL rather than as a mistake", () => {
    // Passing NULL to a parameter is a legitimate thing to want.
    expect(validateParams(params, { count: "", label: "" })).toEqual({});
  });

  it("never complains about an OUT parameter", () => {
    // It takes no input; whatever is in the box is the last result.
    expect(validateParams(params, { result: "not a number" })).toEqual({});
  });

  it("reports every bad value, not just the first", () => {
    const problems = validateParams(
      [
        { name: "a", direction: "IN", dataType: "INT" },
        { name: "b", direction: "IN", dataType: "DECIMAL(10,2)" },
      ],
      { a: "x", b: "y" },
    );
    expect(Object.keys(problems).sort()).toEqual(["a", "b"]);
  });

  it("agrees with what the execute path would do", () => {
    // If these two disagree, either Execute is disabled for a value that
    // would have worked, or it is enabled for one that will not. The execute
    // path passes an empty value as NULL without formatting it, and formats
    // everything else.
    for (const value of ["12", "12.5", "1e5", "abc", "", "  ", "-0.001", "9999999999999"]) {
      const executeWouldAccept = value === "" || formatParamValue(value, "INT").ok;
      const flaggedByTheUi = validateParams(
        [{ name: "n", direction: "IN", dataType: "INT" }],
        { n: value },
      ).n !== undefined;
      expect(flaggedByTheUi).toBe(!executeWouldAccept);
    }
  });
});

describe("the batch a procedure call runs (#394)", () => {
  const params = [
    { name: "p_in", direction: "IN", dataType: "VARCHAR(64)" },
    { name: "p_out", direction: "OUT", dataType: "VARCHAR(64)" },
  ];

  const sqlOf = (values: Record<string, string>) => {
    const built = buildProcedureBatch("shop", "recalc", params, values);
    if (!built.ok) throw new Error(built.reason);
    return built.sql;
  };

  it("sets every parameter, calls, and reads the OUT values back", () => {
    const sql = sqlOf({ p_in: "hello" });
    expect(sql).toContain("SET @sqlpilot_param_p_in = 'hello'");
    expect(sql).toContain("SET @sqlpilot_param_p_out = NULL");
    expect(sql).toContain(
      "CALL `shop`.`recalc`(@sqlpilot_param_p_in, @sqlpilot_param_p_out)",
    );
    expect(sql).toContain("SELECT @sqlpilot_param_p_out AS `p_out`");
  });

  it("keeps a hostile value inside its literal", () => {
    // Verified against MySQL 8.0.46: the procedure receives this as data and
    // the injected predicate does not run.
    const sql = sqlOf({ p_in: "a' OR 1=1 -- " });
    expect(sql).toContain("SET @sqlpilot_param_p_in = 'a'' OR 1=1 -- '");
    expect(sql).not.toContain("\\'");
  });

  it("quotes the database and the routine name", () => {
    const built = buildProcedureBatch("odd`db", "odd`name", [], {});
    expect(built.ok && built.sql).toContain("CALL `odd``db`.`odd``name`()");
  });

  it("passes an empty value as NULL rather than as an empty string", () => {
    expect(sqlOf({ p_in: "" })).toContain("SET @sqlpilot_param_p_in = NULL");
  });

  it("refuses rather than sending a value the type cannot hold", () => {
    const built = buildProcedureBatch(
      "shop",
      "recalc",
      [{ name: "n", direction: "IN", dataType: "INT" }],
      { n: "123abc" },
    );
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.reason).toContain("n:");
  });

  it("refuses a parameter name that is not a plain identifier", () => {
    // `SET @name` takes the name unquoted, with no way to escape anything.
    const built = buildProcedureBatch(
      "shop",
      "recalc",
      [{ name: "odd name", direction: "IN", dataType: "INT" }],
      {},
    );
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.reason).toContain("plain identifier");
  });

  it("reads an INOUT parameter back as well as an OUT one", () => {
    const sql = (() => {
      const built = buildProcedureBatch(
        "shop",
        "recalc",
        [{ name: "both", direction: "INOUT", dataType: "INT" }],
        { both: "1" },
      );
      return built.ok ? built.sql : "";
    })();
    expect(sql).toContain("SET @sqlpilot_param_both = 1");
    expect(sql).toContain("SELECT @sqlpilot_param_both AS `both`");
  });

  it("has nothing to select when there are no output parameters", () => {
    const built = buildProcedureBatch(
      "shop",
      "recalc",
      [{ name: "x", direction: "IN", dataType: "INT" }],
      { x: "1" },
    );
    expect(built.ok && built.sql).not.toContain("SELECT");
  });

  it("is one batch, because the variables live on one connection", () => {
    // The executor runs a batch on a single pooled connection; sent
    // separately the CALL could land on a session where the SETs never ran.
    const sql = sqlOf({ p_in: "x" });
    expect(sql.trim().endsWith(";")).toBe(true);
    expect(sql.split(";\n").length).toBeGreaterThan(1);
  });
});
