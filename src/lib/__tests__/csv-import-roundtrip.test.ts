import { describe, expect, it } from "vitest";
import { parseCSV } from "../csv-parser";
import { generateBatchInsert } from "../sql-import";

/**
 * A CSV, all the way to the statements that load it.
 *
 * The parser and the INSERT builder each had tests; nothing checked that what
 * comes out of one is what the other needs, which is where the empty-cell
 * distinction was lost before #578 (import audit F8).
 *
 * The SQL these produce was run against MySQL 8.0.46 and MariaDB 11.8, and
 * the rows read back are the ones asserted here.
 */
function load(csv: string, table = "t") {
  const parsed = parseCSV(csv, { delimiter: ",", hasHeader: true, quoteChar: "\"" });
  return generateBatchInsert(table, parsed.headers, parsed.rows, 100, parsed.bareEmpty);
}

describe("CSV to INSERT (import audit F8)", () => {
  it("carries ordinary values through unchanged", () => {
    const [sql] = load("id,name\n1,Ada\n2,Grace\n");
    expect(sql).toBe(
      "INSERT INTO `t` (`id`, `name`) VALUES\n('1', 'Ada'),\n('2', 'Grace');",
    );
  });

  it("keeps the difference between an absent cell and an empty one", () => {
    // `,,` is a value the file does not have; `,\"\",` is a value the file says
    // is empty. Both used to become NULL (#578).
    const [sql] = load("a,b\n,\"\"\n");
    expect(sql).toContain("VALUES\n(NULL, '')");
  });

  it("keeps a quote inside a value as data", () => {
    const [sql] = load("a\n\"it's\"\n");
    expect(sql).toContain("('it''s')");
    expect(sql).not.toContain("\\'");
  });

  it("keeps a value that would end its own statement", () => {
    // The shape that dropped a table through the old escaping (#285).
    const [sql] = load("a\n\"x'); DROP TABLE victim; -- \"\n");
    expect(sql).toContain("('x''); DROP TABLE victim; -- ')");
  });

  it("keeps a comma and a newline inside a quoted field", () => {
    const [sql] = load("a,b\n\"one,two\",\"line1\nline2\"\n");
    expect(sql).toContain("('one,two'");
    expect(sql).toContain("line1\\nline2");
  });

  it("keeps a doubled quote as one quote", () => {
    const [sql] = load("a\n\"say \"\"hi\"\"\"\n");
    expect(sql).toContain("('say \"hi\"')");
  });

  it("treats a short row's missing cells as absent", () => {
    // Not as empty strings: the file stopped, it did not say "".
    const [sql] = load("a,b,c\n1\n");
    expect(sql).toContain("('1', NULL, NULL)");
  });

  it("quotes a column name that needs it", () => {
    const [sql] = load("order,select\n1,2\n");
    expect(sql).toContain("INSERT INTO `t` (`order`, `select`)");
  });

  it("batches rows rather than writing one statement each", () => {
    const rows = Array.from({ length: 250 }, (_, i) => `${i}`).join("\n");
    const statements = load(`a\n${rows}\n`);
    // 250 rows at 100 to a statement.
    expect(statements).toHaveLength(3);
    expect(statements[0].match(/\(/g)?.length).toBe(101); // 100 rows + the column list
  });

  it("produces nothing for a file with only a header", () => {
    expect(load("a,b\n")).toEqual([]);
  });

  it("keeps a value that is the word NULL as a string", () => {
    // The file said the four characters; only an absent cell means NULL.
    const [sql] = load("a\nNULL\n");
    expect(sql).toContain("('NULL')");
  });

  it("does not lose a leading zero", () => {
    // Everything is quoted, so a postcode or an account number keeps its
    // shape; the column's type decides what it becomes.
    const [sql] = load("a\n007\n");
    expect(sql).toContain("('007')");
  });
});
