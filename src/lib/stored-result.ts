import type { QueryResult, ResultHandle } from "../types";

/**
 * Results whose rows stay in the backend's result store
 * (docs/design/RESULT_STORE.md), as the rest of the app holds them.
 *
 * A run through `run_query` returns a handle per statement in place of a
 * `QueryResult`. Rather than teach every part of the app a second shape, a
 * handle becomes a `QueryResult` with no rows and a `stored` reference: the
 * result tabs, banners, history and edit path read the same fields they
 * always have, and the grid reads the rows through `rowSourceFor`, which
 * gives a stored result a source over the store.
 */

/** A handle as a result: everything but the rows, which stay in the store. */
export function fromHandle(handle: ResultHandle): QueryResult {
  const reason = handle.truncation_reason ?? null;
  return {
    query_id: handle.result_id,
    statement_index: handle.statement_index,
    sql: handle.sql,
    columns: handle.columns,
    rows: [],
    rows_affected: handle.rows_affected,
    execution_time_ms: handle.execution_time_ms,
    warnings: handle.warnings,
    rows_truncated: reason !== null,
    truncation_reason: reason,
    total_rows_available: null,
    ...(handle.transaction != null ? { transaction: handle.transaction } : {}),
    stored: { result_id: handle.result_id, row_count: handle.row_count },
  };
}

/** How many rows a result has: what `rows.length` was before results could be stored. */
export function resultRowCount(result: Pick<QueryResult, "rows" | "stored">): number {
  return result.stored ? result.stored.row_count : result.rows?.length ?? 0;
}

/**
 * The store ids these results hold rows under. A stored result with no rows
 * left nothing in the store, and its id is one the store does not know.
 */
export function storedIdsOf(results: readonly QueryResult[]): string[] {
  const ids: string[] = [];
  for (const r of results) {
    if (r.stored && r.stored.row_count > 0) ids.push(r.stored.result_id);
  }
  return ids;
}
