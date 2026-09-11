import type { ColumnInfo } from "../types";
import { quoteIdentifier } from "./sql-quote";

/**
 * The statements the schema tree's menus run.
 *
 * FR-4.3 enumerates a menu per object type and most of them did not exist:
 * no TRUNCATE, no rename, no duplicate, no INSERT template, and nothing at all
 * for creating or dropping a database (#293).
 *
 * Built here rather than inline so each one can be read and tested on its own.
 * Every identifier goes through `quoteIdentifier`, which is the difference
 * between a table called `order details` working and not.
 */

/** `` `db`.`name` ``, which needs no `USE` to resolve. */
export function qualified(database: string, name: string): string {
  return `${quoteIdentifier(database)}.${quoteIdentifier(name)}`;
}

/**
 * A SELECT with the configured limit, and a label that says what it is.
 *
 * The menu said "Select Top 100 Rows" while using `maxResultRows`, which
 * defaults to 1000 — so it was wrong out of the box and wrong again for
 * anyone who changed it (#293).
 */
export function selectTopRows(database: string, table: string, limit: number): string {
  return `SELECT * FROM ${qualified(database, table)} LIMIT ${limit}`;
}

export function selectTopRowsLabel(limit: number): string {
  return `Select Top ${limit.toLocaleString()} Rows`;
}

/**
 * An INSERT naming every column, for someone to fill in.
 *
 * Generated columns are left out: the server rejects an INSERT that assigns
 * one, so including them produces a template that cannot run. Columns with a
 * default are kept — the point of a template is to show what a row has.
 */
export function insertTemplate(
  database: string,
  table: string,
  columns: ColumnInfo[],
): string {
  const usable = columns.filter((c) => !/\bGENERATED\b/i.test(c.extra ?? ""));
  if (usable.length === 0) return `INSERT INTO ${qualified(database, table)} () VALUES ();`;

  const names = usable.map((c) => quoteIdentifier(c.name)).join(", ");
  const placeholders = usable
    .map((c) => {
      // The declared type beside each placeholder, because a template whose
      // every value reads `?` tells you nothing about what goes there.
      const hint = c.column_type || c.data_type;
      return `/* ${c.name}: ${hint}${c.nullable ? ", nullable" : ""} */ NULL`;
    })
    .join(",\n  ");

  return `INSERT INTO ${qualified(database, table)} (${names})\nVALUES (\n  ${placeholders}\n);`;
}

/** Empty a table, keeping its structure. */
export function truncateTable(database: string, table: string): string {
  return `TRUNCATE TABLE ${qualified(database, table)}`;
}

/**
 * Rename within the same database.
 *
 * `RENAME TABLE` rather than `ALTER TABLE ... RENAME`: it is the form that
 * takes a qualified destination, so the statement says which database the
 * table lands in rather than depending on the session's.
 */
export function renameTable(database: string, from: string, to: string): string {
  return `RENAME TABLE ${qualified(database, from)} TO ${qualified(database, to)}`;
}

/**
 * Copy a table's structure, without its rows.
 *
 * `CREATE TABLE ... LIKE` carries the indexes and column attributes, which
 * `CREATE TABLE ... AS SELECT` silently drops — the difference between a copy
 * you can use and one that looks right until something needs an index.
 */
export function duplicateTableStructure(database: string, from: string, to: string): string {
  return `CREATE TABLE ${qualified(database, to)} LIKE ${qualified(database, from)}`;
}

export function dropTable(database: string, table: string): string {
  return `DROP TABLE ${qualified(database, table)}`;
}

export function createDatabase(name: string, charset?: string, collation?: string): string {
  const parts = [`CREATE DATABASE ${quoteIdentifier(name)}`];
  // Left to the server when not given: its default is almost always what
  // someone wants, and guessing one here would silently disagree with the
  // rest of the server.
  if (charset) parts.push(`CHARACTER SET ${quoteIdentifier(charset)}`);
  if (collation) parts.push(`COLLATE ${quoteIdentifier(collation)}`);
  return parts.join(" ");
}

export function dropDatabase(name: string): string {
  return `DROP DATABASE ${quoteIdentifier(name)}`;
}

/**
 * What a database holds, in one row per table.
 *
 * FR-4.3.2's "statistics". Read from `information_schema` rather than by
 * counting rows, because counting every row of every table to populate a
 * context-menu item is not a thing to do to a production server — and the
 * estimate is what the details panel shows too.
 */
export function databaseStatistics(database: string): string {
  return `SELECT TABLE_NAME AS \`Table\`,
       ENGINE AS \`Engine\`,
       TABLE_ROWS AS \`Rows (approx)\`,
       ROUND(DATA_LENGTH / 1024 / 1024, 1) AS \`Data MB\`,
       ROUND(INDEX_LENGTH / 1024 / 1024, 1) AS \`Index MB\`,
       TABLE_COLLATION AS \`Collation\`,
       CREATE_TIME AS \`Created\`
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ${quoteLiteral(database)}
ORDER BY DATA_LENGTH DESC`;
}

/** Single-quote a string for a literal comparison. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Whether a name is usable as an identifier without further thought.
 *
 * Not a restriction on what MySQL accepts — quoting handles nearly anything —
 * but a check that the user typed something rather than nothing, and did not
 * paste a statement into a name box.
 */
export function isValidObjectName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 64 && !/[\0\n\r]/.test(trimmed);
}
