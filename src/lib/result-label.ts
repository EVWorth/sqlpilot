import type { QueryResult } from "../types";

/**
 * A short name for one result of a script, for its tab above the grid (#844).
 *
 * "Result 1 / Result 2" said nothing about which statement each came from.
 * The verb and the table it names, with the row or affected count, is enough
 * to tell the statements of an ordinary script apart.
 */

/** Strip comments, so the verb is the first word that runs. */
function withoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(--|#)[^\n]*/g, " ").trim();
}

const TABLE_AFTER = /\b(?:FROM|INTO|UPDATE|TABLE|DESCRIBE|DESC)\s+((?:`[^`]+`|[\w$]+)(?:\.(?:`[^`]+`|[\w$]+))?)/i;

/** The statement's verb and the table it names, when it names one: "SELECT products". */
export function statementLabel(sql: string): string {
  const s = withoutComments(sql);
  const verb = /^[A-Za-z]+/.exec(s)?.[0]?.toUpperCase();
  if (!verb) return "Statement";
  const table = TABLE_AFTER.exec(s)?.[1]?.replace(/`/g, "");
  return table ? `${verb} ${table}` : verb;
}

/** What the result holds: its rows when it has columns, else what it changed. */
export function resultCount(result: QueryResult): string {
  if (result.columns.length > 0) {
    const n = result.rows.length;
    return `${n.toLocaleString()} row${n === 1 ? "" : "s"}${result.rows_truncated ? "+" : ""}`;
  }
  const n = Number(result.rows_affected);
  return `${n.toLocaleString()} affected`;
}

/** The label for the result's tab. */
export function resultLabel(result: QueryResult, fallbackIndex: number): string {
  const name = result.sql ? statementLabel(result.sql) : `Result ${fallbackIndex + 1}`;
  return `${name} · ${resultCount(result)}`;
}

/** The result to show first: the first one with a grid, else the first. */
export function firstGridIndex(results: readonly QueryResult[]): number {
  const idx = results.findIndex((r) => r.columns.length > 0);
  return idx < 0 ? 0 : idx;
}
