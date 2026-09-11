import { formatSqlValue } from "./sql-generator";
import { quoteIdentifier } from "./sql-quote";

/**
 * Turning selected rows into something pasteable.
 *
 * FR-3.3.4, FR-3.3.6 and FR-3.3.7. Copy produced tab-separated text and
 * nothing else, so pasting a result into a ticket, a test fixture or a
 * migration all meant reformatting it by hand (#416).
 *
 * Every format takes the same shape — the columns and the rows to include —
 * so the menu can offer them uniformly and a selection applies to all of them.
 */

export type CopyFormat = "tsv" | "csv" | "json" | "markdown" | "insert" | "update";

export const COPY_FORMAT_LABEL: Record<CopyFormat, string> = {
  tsv: "Tab-separated",
  csv: "CSV",
  json: "JSON",
  markdown: "Markdown table",
  insert: "INSERT statements",
  update: "UPDATE statements",
};

export interface CopySource {
  columns: { name: string; dataType?: string }[];
  /** Cell values, in the same column order, for the rows being copied. */
  rows: unknown[][];
}

/** A cell as plain text, with NULL distinguishable from the word "NULL". */
function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return `0x${value.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return String(value);
}

function toTsv({ columns, rows }: CopySource): string {
  return [
    columns.map((c) => c.name).join("\t"),
    // A tab or a newline inside a value would break the row apart, and TSV has
    // no way to escape either — spaces keep the shape, which is the only thing
    // this format is for.
    ...rows.map((row) => row.map((v) => asText(v).replace(/[\t\r\n]+/g, " ")).join("\t")),
  ].join("\n");
}

/** RFC 4180: quote when needed, and double an embedded quote. */
function csvCell(value: unknown): string {
  const text = asText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function toCsv({ columns, rows }: CopySource): string {
  return [
    columns.map((c) => csvCell(c.name)).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ].join("\n");
}

function toJson({ columns, rows }: CopySource): string {
  return JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(
        // NULL stays null rather than becoming "": JSON can say "absent", and
        // flattening it to an empty string loses the distinction the database
        // was keeping.
        columns.map((c, i) => [c.name, row[i] === undefined ? null : row[i]]),
      )
    ),
    null,
    2,
  );
}

/** A pipe inside a cell would start a new column, and a newline a new row. */
function markdownCell(value: unknown): string {
  return asText(value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function toMarkdown({ columns, rows }: CopySource): string {
  const header = `| ${columns.map((c) => markdownCell(c.name)).join(" | ")} |`;
  const rule = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`);
  return [header, rule, ...body].join("\n");
}

function toInsert({ columns, rows }: CopySource, table: string): string {
  const names = columns.map((c) => quoteIdentifier(c.name)).join(", ");
  return rows
    .map((row) => {
      const values = row
        .map((v, i) => formatSqlValue(v, columns[i]?.dataType))
        .join(", ");
      return `INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${values});`;
    })
    .join("\n");
}

/**
 * One UPDATE per row, keyed on the columns that identify it.
 *
 * The SET list deliberately excludes the key: `SET id = 1 WHERE id = 1` is
 * noise at best, and on a table with an auto-increment it is a statement that
 * reassigns the key to itself.
 */
function toUpdate({ columns, rows }: CopySource, table: string, keyColumns: string[]): string {
  const keys = new Set(keyColumns);
  return rows
    .map((row) => {
      const set = columns
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => !keys.has(c.name))
        .map(({ c, i }) => `${quoteIdentifier(c.name)} = ${formatSqlValue(row[i], c.dataType)}`)
        .join(", ");
      const where = columns
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => keys.has(c.name))
        .map(({ c, i }) =>
          row[i] === null || row[i] === undefined
            ? `${quoteIdentifier(c.name)} IS NULL`
            : `${quoteIdentifier(c.name)} = ${formatSqlValue(row[i], c.dataType)}`
        )
        .join(" AND ");
      return `UPDATE ${quoteIdentifier(table)} SET ${set} WHERE ${where};`;
    })
    .join("\n");
}

export interface SqlContext {
  /** The table the rows came from, or null when no single table owns them. */
  table: string | null;
  /** The columns that identify a row, from the schema (#387). */
  keyColumns: string[];
}

/**
 * Render, or say why not.
 *
 * The SQL formats need a table to name and, for UPDATE, something to match on.
 * Neither can be invented: an INSERT into `your_table` produces "table doesn't
 * exist" on paste (#409), and an UPDATE with no WHERE rewrites the table.
 */
export function renderCopy(
  format: CopyFormat,
  source: CopySource,
  sql?: SqlContext,
): { text: string } | { refusal: string } {
  switch (format) {
    case "tsv":
      return { text: toTsv(source) };
    case "csv":
      return { text: toCsv(source) };
    case "json":
      return { text: toJson(source) };
    case "markdown":
      return { text: toMarkdown(source) };
    case "insert":
      if (!sql?.table) {
        return { refusal: "Copy as INSERT needs one source table to name." };
      }
      return { text: toInsert(source, sql.table) };
    case "update":
      if (!sql?.table) {
        return { refusal: "Copy as UPDATE needs one source table to name." };
      }
      if (sql.keyColumns.length === 0) {
        return {
          refusal: "Copy as UPDATE needs a key to match on — "
            + "without one every statement would rewrite the whole table.",
        };
      }
      if (sql.keyColumns.length >= source.columns.length) {
        return {
          refusal: "Copy as UPDATE needs a column that is not part of the key to set.",
        };
      }
      return { text: toUpdate(source, sql.table, sql.keyColumns) };
  }
}
