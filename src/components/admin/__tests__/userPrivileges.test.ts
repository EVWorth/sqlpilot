import { describe, expect, it } from "vitest";
import { categorizeGrants, escapeIdentifier, parseGrantStatements } from "../userPrivileges";

describe("escapeIdentifier", () => {
  it("escapes single quotes in identifier", () => {
    expect(escapeIdentifier("it's")).toBe("'it''s'");
  });

  it("wraps simple names in quotes", () => {
    expect(escapeIdentifier("my_table")).toBe("'my_table'");
  });
});

describe("parseGrantStatements", () => {
  it("parses simple grant", () => {
    const result = parseGrantStatements([
      "GRANT SELECT, INSERT ON mydb.* TO 'user'@'host'",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].privileges).toEqual(["SELECT", "INSERT"]);
    expect(result[0].scope).toBe("mydb.*");
    expect(result[0].grantOption).toBe(false);
  });

  it("parses ALL PRIVILEGES", () => {
    const result = parseGrantStatements([
      "GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost'",
    ]);
    expect(result[0].privileges).toEqual(["ALL PRIVILEGES"]);
    expect(result[0].scope).toBe("*.*");
  });

  it("detects GRANT OPTION", () => {
    const result = parseGrantStatements([
      "GRANT SELECT ON db.* TO 'u'@'h' WITH GRANT OPTION",
    ]);
    expect(result[0].grantOption).toBe(true);
  });

  it("skips malformed lines", () => {
    const result = parseGrantStatements(["this is not a grant", ""]);
    expect(result).toHaveLength(0);
  });

  it("strips parenthesized args from privileges", () => {
    const result = parseGrantStatements([
      "GRANT SELECT(col1), INSERT ON db.tbl TO 'u'@'h'",
    ]);
    expect(result[0].privileges).toEqual(["SELECT", "INSERT"]);
  });

  it("parses multiple grants", () => {
    const result = parseGrantStatements([
      "GRANT SELECT ON db1.* TO 'u'@'h'",
      "GRANT INSERT ON db2.tbl TO 'u'@'h'",
    ]);
    expect(result).toHaveLength(2);
  });
});

describe("categorizeGrants", () => {
  it("categorizes global grants (*.*)", () => {
    const parsed = parseGrantStatements([
      "GRANT SELECT ON *.* TO 'root'@'localhost'",
    ]);
    const { global } = categorizeGrants(parsed);
    expect(global).toHaveLength(1);
  });

  it("categorizes database grants (db.*)", () => {
    const parsed = parseGrantStatements([
      "GRANT SELECT ON mydb.* TO 'u'@'h'",
    ]);
    const { database } = categorizeGrants(parsed);
    expect(database.has("mydb")).toBe(true);
  });

  it("categorizes table grants (db.table)", () => {
    const parsed = parseGrantStatements([
      "GRANT SELECT ON mydb.users TO 'u'@'h'",
    ]);
    const { table } = categorizeGrants(parsed);
    expect(table).toHaveLength(1);
  });

  it("handles mixed scopes", () => {
    const parsed = parseGrantStatements([
      "GRANT SELECT ON *.* TO 'r'@'h'",
      "GRANT INSERT ON db1.* TO 'u'@'h'",
      "GRANT UPDATE ON db1.users TO 'u'@'h'",
    ]);
    const { global, database, table } = categorizeGrants(parsed);
    expect(global).toHaveLength(1);
    expect(database.size).toBe(1);
    expect(table).toHaveLength(1);
  });

  it("handles backtick-quoted scopes", () => {
    const parsed = parseGrantStatements([
      "GRANT SELECT ON `mydb`.`users` TO 'u'@'h'",
    ]);
    const { table } = categorizeGrants(parsed);
    expect(table).toHaveLength(1);
  });
});
