import { describe, expect, it } from "vitest";
import { splitSqliteStatements } from "../sqlite-split";

describe("splitSqliteStatements (#928)", () => {
  it("splits on semicolons and keeps an unterminated last statement", () => {
    expect(splitSqliteStatements("CREATE TABLE a(x); CREATE TABLE b(y);\nSELECT 1")).toEqual([
      "CREATE TABLE a(x)",
      "CREATE TABLE b(y)",
      "SELECT 1",
    ]);
  });

  it("does not split inside strings, quoted names or comments", () => {
    expect(
      splitSqliteStatements("INSERT INTO t VALUES ('a;b', 'it''s; x'); SELECT \"p;q\", [r;s] /* ; */ FROM t -- ;\n;"),
    ).toEqual([
      "INSERT INTO t VALUES ('a;b', 'it''s; x')",
      "SELECT \"p;q\", [r;s] /* ; */ FROM t -- ;",
    ]);
  });

  it("keeps a trigger body whole", () => {
    const parts = splitSqliteStatements(
      "CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE t SET x = CASE WHEN x THEN 1 END;\n  DELETE FROM u;\nEND;\nSELECT 1;",
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^CREATE TRIGGER tr[\s\S]*END$/);
    expect(parts[1]).toBe("SELECT 1");
  });

  it("drops pieces with only comments in them", () => {
    expect(splitSqliteStatements(";; -- note\n/* more */; SELECT 1;;")).toEqual(["SELECT 1"]);
  });
});
