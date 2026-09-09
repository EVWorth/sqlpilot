import { describe, expect, it } from "vitest";
import { generateBatchInsert, splitSqlStatements } from "../sql-import";

describe("splitSqlStatements", () => {
  it("should split simple statements", () => {
    const result = splitSqlStatements("SELECT 1; SELECT 2;");
    expect(result).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("should handle strings with semicolons", () => {
    const result = splitSqlStatements("SELECT 'a;b'; SELECT 2;");
    expect(result).toEqual(["SELECT 'a;b'", "SELECT 2"]);
  });

  it("should handle backtick-quoted identifiers", () => {
    const result = splitSqlStatements("SELECT `a;b`; SELECT 2;");
    expect(result).toEqual(["SELECT `a;b`", "SELECT 2"]);
  });

  it("should handle double-quoted strings", () => {
    const result = splitSqlStatements("SELECT \"a;b\"; SELECT 2;");
    expect(result).toEqual(["SELECT \"a;b\"", "SELECT 2"]);
  });

  it("should handle line comments", () => {
    const result = splitSqlStatements(
      "-- comment\nSELECT 1; -- another\nSELECT 2;",
    );
    expect(result).toEqual(["-- comment\nSELECT 1", "-- another\nSELECT 2"]);
  });

  it("should handle block comments", () => {
    const result = splitSqlStatements("SELECT /* ; */ 1; SELECT 2;");
    expect(result).toEqual(["SELECT /* ; */ 1", "SELECT 2"]);
  });

  it("should handle trailing content without semicolon", () => {
    const result = splitSqlStatements("SELECT 1; SELECT 2");
    expect(result).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("should skip empty statements", () => {
    const result = splitSqlStatements("SELECT 1;; ;\nSELECT 2;");
    expect(result).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("should handle escaped quotes in strings", () => {
    const result = splitSqlStatements("SELECT 'it''s'; SELECT 2;");
    expect(result).toEqual(["SELECT 'it''s'", "SELECT 2"]);
  });
});

describe("generateBatchInsert", () => {
  it("should generate single INSERT for small data", () => {
    const result = generateBatchInsert(
      "users",
      ["name", "age"],
      [
        ["Alice", "30"],
        ["Bob", "25"],
      ],
      100,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("INSERT INTO `users`");
    expect(result[0]).toContain("(`name`, `age`)");
    expect(result[0]).toContain("('Alice', '30')");
    expect(result[0]).toContain("('Bob', '25')");
  });

  it("should batch rows according to batchSize", () => {
    const rows = Array.from({ length: 5 }, (_, i) => [String(i)]);
    const result = generateBatchInsert("t", ["id"], rows, 2);
    expect(result).toHaveLength(3);
  });

  it("should escape special characters", () => {
    const result = generateBatchInsert(
      "t",
      ["val"],
      [["it's a test"]],
      100,
    );
    expect(result[0]).toContain("'it\\'s a test'");
  });

  it("should quote literal string 'null' rather than converting to SQL NULL", () => {
    const result = generateBatchInsert("t", ["val"], [["null"]], 100);
    expect(result[0]).toContain("'null'");
  });

  it("should handle empty values as NULL", () => {
    const result = generateBatchInsert("t", ["val"], [[""]], 100);
    expect(result[0]).toContain("NULL");
  });

  it("should return empty array for empty input", () => {
    expect(generateBatchInsert("t", ["a"], [], 100)).toEqual([]);
    expect(generateBatchInsert("t", [], [["x"]], 100)).toEqual([]);
  });

  it("should escape backticks in table and column names", () => {
    const result = generateBatchInsert("my`table", ["col`1"], [["val"]], 100);
    expect(result[0]).toContain("`my``table`");
    expect(result[0]).toContain("`col``1`");
  });
});

describe("CSV cells reach the server as values, not as SQL", () => {
  const insert = (value: string) => generateBatchInsert("t", ["c"], [[value]], 10)[0];

  it("keeps a quote-and-semicolon payload inside the literal", () => {
    // The escape table is the security boundary — the point #364 makes. It is
    // the shared one now, so there is a single implementation to get right.
    const sql = insert("x'); DROP TABLE users; --");
    expect(sql).toContain("'x\\'); DROP TABLE users; --'");
    // One statement, and the payload is inside the quotes.
    expect(sql.match(/INSERT INTO/g)).toHaveLength(1);
  });

  it("doubles a backslash, so it cannot escape the closing quote", () => {
    // The failure that bit admin (#444) and the routine viewer (#397): a
    // trailing backslash swallowing the quote that ends the literal.
    expect(insert("ends with \\")).toContain("'ends with \\\\'");
  });

  it("escapes the characters MySQL reads specially", () => {
    const sql = insert("a\nb\rc\u0000d");
    expect(sql).toContain("\\n");
    expect(sql).toContain("\\r");
    expect(sql).toContain("\\0");
  });

  it("quotes identifiers, so a backtick in a name cannot end the quoting", () => {
    const sql = generateBatchInsert("we`ird", ["col`umn"], [["v"]], 10)[0];
    expect(sql).toContain("INSERT INTO `we``ird` (`col``umn`)");
  });

  it("writes an empty cell as NULL", () => {
    // A choice, not a reading of the file: CSV cannot distinguish an empty
    // string from an absent value once parsed (#578).
    expect(insert("")).toContain("(NULL)");
  });
});
