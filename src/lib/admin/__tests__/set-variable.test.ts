import { describe, expect, it } from "vitest";
import { buildSetVariable, scopesFor, survivesRestart } from "../set-variable";

describe("scopesFor (#438)", () => {
  it("offers PERSIST on MySQL", () => {
    expect(scopesFor("mysql")).toContain("persist");
  });

  it("does not offer PERSIST on MariaDB", () => {
    // MariaDB rejects SET PERSIST outright; offering it would move the
    // failure to after the user committed to it.
    expect(scopesFor("mariadb")).not.toContain("persist");
    expect(scopesFor("mariadb")).toEqual(["global", "session"]);
  });
});

describe("survivesRestart", () => {
  it("is true only for PERSIST", () => {
    // The surprise people hit: GLOBAL holds until the server stops.
    expect(survivesRestart("global")).toBe(false);
    expect(survivesRestart("session")).toBe(false);
    expect(survivesRestart("persist")).toBe(true);
  });
});

describe("buildSetVariable", () => {
  it("sets a numeric value unquoted", () => {
    expect(buildSetVariable("max_connections", "151", "global"))
      .toBe("SET GLOBAL max_connections = 151");
  });

  it("sets a negative and a decimal unquoted", () => {
    expect(buildSetVariable("v", "-1", "global")).toContain("= -1");
    expect(buildSetVariable("v", "1.5", "global")).toContain("= 1.5");
  });

  it("quotes a string value", () => {
    expect(buildSetVariable("sql_mode", "STRICT_TRANS_TABLES", "global"))
      .toBe("SET GLOBAL sql_mode = 'STRICT_TRANS_TABLES'");
  });

  it("leaves ON and OFF as keywords", () => {
    // Quoting a boolean sets it to the literal text, which is an error.
    expect(buildSetVariable("general_log", "ON", "global")).toBe("SET GLOBAL general_log = ON");
    expect(buildSetVariable("general_log", "off", "global")).toBe("SET GLOBAL general_log = OFF");
  });

  it("leaves DEFAULT as a keyword", () => {
    expect(buildSetVariable("v", "DEFAULT", "session")).toBe("SET SESSION v = DEFAULT");
  });

  it("escapes a value containing a quote", () => {
    expect(buildSetVariable("init_connect", "SET x='y'", "global"))
      .toBe(`SET GLOBAL init_connect = 'SET x=''y'''`);
  });

  it("uses the right keyword per scope", () => {
    expect(buildSetVariable("v", "1", "session")).toMatch(/^SET SESSION /);
    expect(buildSetVariable("v", "1", "persist")).toMatch(/^SET PERSIST /);
  });

  it("refuses a name that is not a variable name", () => {
    // The name sits where no quoting is possible, so the only safe handling
    // is to refuse anything that is not an identifier.
    for (const bad of ["max_connections; DROP TABLE t", "a b", "`x`", "", "1abc"]) {
      expect(() => buildSetVariable(bad, "1", "global")).toThrow();
    }
  });

  it("accepts an ordinary variable name", () => {
    expect(() => buildSetVariable("innodb_buffer_pool_size", "1", "global")).not.toThrow();
  });
});
