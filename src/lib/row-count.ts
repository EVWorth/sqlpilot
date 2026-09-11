import { resolveEditTarget } from "./sql-generator";

/**
 * How many rows the query would have returned, when the grid only has a page.
 *
 * FR-3.1.7. A truncated result said "truncated to 1000 rows" and nothing more,
 * so the user could not tell 1000 of 1,200 from 1000 of 12,000,000 — which is
 * the difference between scrolling on and rewriting the query (#391, #402).
 *
 * Two answers, because they cost different amounts. An estimate is free:
 * `information_schema.TABLES` already holds the engine's own row estimate, and
 * for the common `SELECT * FROM t` that is the answer. An exact count is a
 * full scan, so it is only ever run when asked for.
 */

/**
 * What a count request would cost, or why one cannot be made.
 *
 * A statement that cannot be wrapped in `SELECT COUNT(*) FROM (…)` is not
 * counted at all rather than counted wrongly — `SHOW`, `CALL`, and anything
 * carrying its own `INTO` are all rejected by the server when wrapped, and a
 * failed count reported as zero would be worse than no count.
 */
export type CountPlan =
  | { kind: "none"; reason: string }
  /** A plain table read: the engine's estimate is free and the exact count is a scan. */
  | { kind: "table"; estimateSql: string; exactSql: string }
  /** An arbitrary SELECT: no free estimate, but it can be wrapped and counted. */
  | { kind: "wrapped"; exactSql: string };

/** Statements whose shape `SELECT COUNT(*) FROM (…) x` cannot legally take. */
const NOT_COUNTABLE = /^\s*(SHOW|DESCRIBE|DESC|EXPLAIN|CALL|SET|USE|ANALYZE|CHECK|OPTIMIZE|REPAIR)\b/i;

/** Clauses that make a statement unusable as a derived table. */
const NOT_DERIVABLE = /\b(INTO\s+(OUTFILE|DUMPFILE|@)|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE)\b/i;

export function planCount(sql: string, database: string | null | undefined): CountPlan {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) return { kind: "none", reason: "there is no statement to count" };
  if (NOT_COUNTABLE.test(trimmed)) {
    return { kind: "none", reason: "this kind of statement cannot be counted" };
  }
  if (NOT_DERIVABLE.test(trimmed)) {
    return { kind: "none", reason: "this statement cannot be used as a subquery" };
  }

  // A named subquery: MySQL requires every derived table to have an alias.
  const exactSql = `SELECT COUNT(*) FROM (${trimmed}) AS sqlpilot_count`;

  const target = resolveEditTarget(trimmed);
  // The estimate is only the table's if the query reads the whole table.
  // A WHERE clause makes information_schema's number an answer to a
  // different question, and reporting it would be a confident wrong number.
  if (target.editable && target.table && database && !/\bWHERE\b/i.test(trimmed)) {
    return {
      kind: "table",
      estimateSql: `SELECT TABLE_ROWS FROM information_schema.TABLES `
        + `WHERE TABLE_SCHEMA = ${quoteLiteral(database)} `
        + `AND TABLE_NAME = ${quoteLiteral(target.table)}`,
      exactSql,
    };
  }

  return { kind: "wrapped", exactSql };
}

/** Single-quote a string for a literal comparison. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * How to phrase what is known about the total.
 *
 * "approximately" is doing real work: InnoDB's TABLE_ROWS is sampled from the
 * index and can be out by a wide margin on a table with churn. Presenting it
 * as exact would make the exact count look like a bug when the two disagree.
 */
export function describeTotal(
  shown: number,
  total: { value: number; exact: boolean } | null,
): string | null {
  if (!total) return null;
  const n = total.value.toLocaleString();
  return total.exact
    ? `${shown.toLocaleString()} of ${n} rows`
    : `${shown.toLocaleString()} of approximately ${n} rows`;
}
