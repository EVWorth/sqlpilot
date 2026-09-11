import { describe, expect, it } from "vitest";
import { type CopySource, renderCopy } from "../copy-formats";

const source: CopySource = {
  columns: [
    { name: "id", dataType: "int" },
    { name: "name", dataType: "varchar" },
    { name: "note", dataType: "text" },
  ],
  rows: [
    [1, "Alice", null],
    [2, "O'Brien", "has, a comma"],
  ],
};

const text = (r: ReturnType<typeof renderCopy>) => ("text" in r ? r.text : `REFUSED: ${r.refusal}`);

describe("copy-formats (#416)", () => {
  describe("tsv", () => {
    it("keeps one row per line", () => {
      expect(text(renderCopy("tsv", source))).toBe(
        "id\tname\tnote\n1\tAlice\t\n2\tO'Brien\thas, a comma",
      );
    });

    it("flattens a tab or newline inside a value", () => {
      // TSV has no escape for either, so the row would break apart.
      const out = text(renderCopy("tsv", {
        columns: [{ name: "a" }, { name: "b" }],
        rows: [["one\ttwo", "three\nfour"]],
      }));
      expect(out.split("\n")).toHaveLength(2);
      expect(out).toContain("one two\tthree four");
    });
  });

  describe("csv", () => {
    it("quotes only what needs quoting, and doubles an embedded quote", () => {
      const out = text(renderCopy("csv", {
        columns: [{ name: "a" }, { name: "b" }, { name: "c" }],
        rows: [["plain", "has, comma", "say \"hi\""]],
      }));
      expect(out).toBe("a,b,c\nplain,\"has, comma\",\"say \"\"hi\"\"\"");
    });

    it("keeps a newline inside a quoted field, which CSV allows", () => {
      const out = text(renderCopy("csv", {
        columns: [{ name: "a" }],
        rows: [["line\nbreak"]],
      }));
      expect(out).toBe("a\n\"line\nbreak\"");
    });
  });

  describe("json", () => {
    it("names the columns and keeps NULL as null", () => {
      // Flattening NULL to "" loses a distinction the database was keeping.
      expect(JSON.parse(text(renderCopy("json", source)))).toEqual([
        { id: 1, name: "Alice", note: null },
        { id: 2, name: "O'Brien", note: "has, a comma" },
      ]);
    });
  });

  describe("markdown", () => {
    it("renders a table with a rule under the header", () => {
      expect(text(renderCopy("markdown", source))).toBe(
        "| id | name | note |\n"
          + "| --- | --- | --- |\n"
          + "| 1 | Alice |  |\n"
          + "| 2 | O'Brien | has, a comma |",
      );
    });

    it("escapes a pipe, which would otherwise start a new column", () => {
      const out = text(renderCopy("markdown", {
        columns: [{ name: "a" }],
        rows: [["x|y"]],
      }));
      expect(out).toContain("| x\\|y |");
    });
  });

  describe("insert", () => {
    it("names the table the rows came from", () => {
      // `your_table` produced "table doesn't exist" on paste (#409).
      const out = text(renderCopy("insert", source, { table: "users", keyColumns: ["id"] }));
      expect(out.split("\n")[0]).toBe(
        "INSERT INTO `users` (`id`, `name`, `note`) VALUES (1, 'Alice', NULL);",
      );
    });

    it("escapes a quote in a value", () => {
      const out = text(renderCopy("insert", source, { table: "users", keyColumns: ["id"] }));
      expect(out).toContain("'O''Brien'");
    });

    it("refuses when no single table owns the rows", () => {
      const out = renderCopy("insert", source, { table: null, keyColumns: [] });
      expect("refusal" in out && out.refusal).toMatch(/one source table/);
    });
  });

  describe("update", () => {
    it("sets the other columns and matches on the key", () => {
      const out = text(renderCopy("update", source, { table: "users", keyColumns: ["id"] }));
      expect(out.split("\n")[0]).toBe(
        "UPDATE `users` SET `name` = 'Alice', `note` = NULL WHERE `id` = 1;",
      );
    });

    it("leaves the key out of the SET list", () => {
      // `SET id = 1 WHERE id = 1` is noise, and on an auto-increment it is a
      // statement that reassigns the key to itself.
      const out = text(renderCopy("update", source, { table: "users", keyColumns: ["id"] }));
      expect(out).not.toContain("SET `id`");
    });

    it("matches on every part of a composite key", () => {
      const out = text(renderCopy("update", source, {
        table: "users",
        keyColumns: ["id", "name"],
      }));
      expect(out).toContain("WHERE `id` = 1 AND `name` = 'Alice'");
      expect(out).toContain("SET `note` = NULL");
    });

    it("matches a NULL key part with IS NULL", () => {
      const out = text(renderCopy("update", {
        columns: [{ name: "k" }, { name: "v" }],
        rows: [[null, 1]],
      }, { table: "t", keyColumns: ["k"] }));
      expect(out).toContain("WHERE `k` IS NULL");
    });

    it("refuses without a key rather than rewriting the table", () => {
      const out = renderCopy("update", source, { table: "users", keyColumns: [] });
      expect("refusal" in out && out.refusal).toMatch(/key to match on/);
    });

    it("refuses when every column is part of the key", () => {
      // There would be nothing left to SET.
      const out = renderCopy("update", {
        columns: [{ name: "a" }, { name: "b" }],
        rows: [[1, 2]],
      }, { table: "t", keyColumns: ["a", "b"] });
      expect("refusal" in out && out.refusal).toMatch(/not part of the key/);
    });

    it("refuses when no single table owns the rows", () => {
      const out = renderCopy("update", source, { table: null, keyColumns: ["id"] });
      expect("refusal" in out && out.refusal).toMatch(/one source table/);
    });
  });

  it("renders bytes as a hex literal rather than a list of numbers", () => {
    const out = text(renderCopy("csv", {
      columns: [{ name: "blob" }],
      rows: [[[0x89, 0x50]]],
    }));
    expect(out).toBe("blob\n0x8950");
  });
});
