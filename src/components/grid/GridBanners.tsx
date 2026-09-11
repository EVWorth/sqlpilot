import { AlertCircle, AlertTriangle } from "lucide-react";
import type { RowCount } from "../../hooks/useRowCount";
import type { TruncationReason } from "../../lib/bindings";
import { describeTotal } from "../../lib/row-count";
import { truncationMessage } from "../../lib/truncation";

/**
 * What the grid has to say about the result before you read it: that it is
 * only part of the answer, and anything the server warned about.
 *
 * Split out of ResultsGrid (#406).
 */

export interface GridBannersProps {
  rowsShown: number;
  truncated: boolean;
  truncationReason: TruncationReason | null | undefined;
  warnings: string[] | undefined;
  rowCount: RowCount;
}

export function GridBanners({
  rowsShown,
  truncated,
  truncationReason,
  warnings,
  rowCount,
}: GridBannersProps) {
  return (
    <>
      {truncated && (
        <div className="flex items-center gap-2 border-b border-amber-800 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{truncationMessage(rowsShown, truncationReason)}</span>

          {
            /* FR-3.1.7: 1000 of 1,200 and 1000 of 12,000,000 call for different
              responses, and the banner said nothing either way (#402). */
          }
          {rowCount.total && (
            <span className="shrink-0 text-amber-300">
              {describeTotal(rowsShown, rowCount.total)}
            </span>
          )}
          {rowCount.plan.kind !== "none" && !rowCount.total?.exact && (
            <button
              onClick={() => void rowCount.countExactly()}
              disabled={rowCount.counting}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] underline underline-offset-2 hover:bg-amber-900/40 disabled:opacity-50"
              title="Runs COUNT(*) over the same query, which scans the whole table"
            >
              {rowCount.counting ? "Counting…" : "Count exactly"}
            </button>
          )}
          {rowCount.plan.kind === "none" && (
            // Offering a button that cannot work is worse than saying why.
            <span className="shrink-0 text-amber-300/70" title={rowCount.plan.reason}>
              (no count: {rowCount.plan.reason})
            </span>
          )}
          {rowCount.error && <span className="shrink-0 text-red-400">{rowCount.error}</span>}
        </div>
      )}

      {warnings?.map((warning, idx) => (
        <div
          key={idx}
          className="flex items-center gap-2 border-b border-yellow-800 bg-yellow-900/20 px-3 py-1.5 text-xs text-yellow-400"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{warning}</span>
        </div>
      ))}
    </>
  );
}
