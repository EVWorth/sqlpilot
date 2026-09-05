import type { TruncationReason } from "./bindings";

/**
 * What to tell someone whose result set came back short.
 *
 * The banner used to say the same thing either way — "add a LIMIT clause" —
 * which is wrong advice when the cap was memory rather than the row limit.
 * Someone already running `LIMIT 10000` reads that and raises the limit,
 * which cannot work: the constraint was RAM, and a larger limit asks for
 * more of it (#413).
 */
export function truncationMessage(
  rowsShown: number,
  reason: TruncationReason | null | undefined,
): string {
  const shown = rowsShown.toLocaleString();
  switch (reason) {
    case "memory_guard":
      return `Results stopped at ${shown} rows — the app was running low on memory. `
        + `A larger LIMIT will not help; select fewer columns, or narrow the query with a WHERE clause.`;
    case "row_limit":
      return `Results truncated to ${shown} rows by the row limit. `
        + `Raise it in Settings, or add a LIMIT clause to fetch fewer rows.`;
    default:
      // A result from a backend that predates truncation_reason, or one
      // built by hand. Say what is known and claim nothing about why.
      return `Results truncated to ${shown} rows.`;
  }
}
