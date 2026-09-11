import {
  ChevronLeft,
  ChevronRight,
  Copy,
  FileCode,
  FileJson,
  FileSpreadsheet,
  FileText,
  FilterX,
  RotateCcw,
} from "lucide-react";

/**
 * The strip under the grid: where you are, what is narrowing the view, and
 * how to get the rows out.
 *
 * Split out of ResultsGrid, which held this alongside two render paths, the
 * context menu builder and the save handler (#406). It takes values rather
 * than stores so it can be rendered on its own in a test.
 */

export interface PageInfo {
  index: number;
  size: number;
  hasMore: boolean;
}

export interface GridFooterProps {
  /** Rows the query returned for this page. */
  rowsShown: number;
  /** Rows left after the column filters, which is what the grid is drawing. */
  rowsAfterFilter: number;
  executionTimeMs: number;
  /** Null when the result fitted inside the row limit, so paging is moot. */
  page: PageInfo | null;
  isExecuting: boolean;
  onGoToPage: (index: number) => void;
  filterCount: number;
  describeFilters: () => string;
  onClearFilters: () => void;
  isReordered: boolean;
  onResetColumns: () => void;
  onCopy: () => void;
  onExport: (format: string) => void;
}

const BUTTON =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]";

const EXPORTS: { format: string; label: string; icon: typeof FileCode; title: string }[] = [
  { format: "csv", label: "CSV", icon: FileSpreadsheet, title: "Download CSV" },
  { format: "json", label: "JSON", icon: FileJson, title: "Download JSON" },
  { format: "sql", label: "SQL", icon: FileCode, title: "Download SQL" },
  { format: "markdown", label: "MD", icon: FileText, title: "Download Markdown" },
];

export function GridFooter({
  rowsShown,
  rowsAfterFilter,
  executionTimeMs,
  page,
  isExecuting,
  onGoToPage,
  filterCount,
  describeFilters,
  onClearFilters,
  isReordered,
  onResetColumns,
  onCopy,
  onExport,
}: GridFooterProps) {
  return (
    <div className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1">
      <span className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
        {page && (
          // FR-3.1.8. No total is shown because there is none to show: the
          // statement is streamed and stopped at the cap, so the only honest
          // claim is which rows these are and whether more follow (#391).
          <span className="flex items-center gap-0.5">
            <button
              onClick={() => onGoToPage(page.index - 1)}
              disabled={page.index === 0 || isExecuting}
              aria-label="Previous page"
              className="rounded p-0.5 hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
            <span className="tabular-nums">
              rows {page.index * page.size + 1}&ndash;{page.index * page.size + rowsShown}
            </span>
            <button
              onClick={() => onGoToPage(page.index + 1)}
              disabled={!page.hasMore || isExecuting}
              aria-label="Next page"
              title={page.hasMore
                ? "Re-runs the statement and skips the rows already shown"
                : "This is the last page"}
              className="rounded p-0.5 hover:bg-[var(--color-bg-tertiary)] disabled:opacity-30"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          </span>
        )}
        {filterCount > 0
          // Saying only "12 row(s)" under an active filter reads as the query
          // having returned twelve, which is a different fact (#391).
          ? `${rowsAfterFilter} of ${rowsShown} row(s)`
          : `${rowsShown} row(s)`} &middot; {executionTimeMs}ms
      </span>
      <div className="flex items-center gap-1">
        {filterCount > 0 && (
          <button
            onClick={onClearFilters}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-brand-400 hover:bg-[var(--color-bg-tertiary)]"
            title={describeFilters()}
          >
            <FilterX className="h-3 w-3" />
            Clear {filterCount} filter{filterCount === 1 ? "" : "s"}
          </button>
        )}
        {isReordered && (
          // A dragged order outlives the query, so without a way back a stray
          // drag is permanent (#392).
          <button
            onClick={onResetColumns}
            className={BUTTON}
            title="Put the columns back in the order the query returned them"
          >
            <RotateCcw className="h-3 w-3" /> Reset columns
          </button>
        )}
        <button onClick={onCopy} className={BUTTON} title="Copy as tab-separated values">
          <Copy className="h-3 w-3" /> Copy
        </button>
        {EXPORTS.map(({ format, label, icon: Icon, title }) => (
          <button
            key={format}
            onClick={() => onExport(format)}
            className={BUTTON}
            title={title}
          >
            <Icon className="h-3 w-3" /> {label}
          </button>
        ))}
      </div>
    </div>
  );
}
