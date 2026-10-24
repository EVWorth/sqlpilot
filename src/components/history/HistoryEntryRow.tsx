import { CheckCircle, Clock, X, XCircle } from "lucide-react";
import type { MouseEvent } from "react";
import { formatDurationMs } from "../../lib/format-duration";
import { cn } from "../../lib/utils";
import type { HistoryEntry } from "../../stores/historyStore";

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * One history entry.
 *
 * The row is a plain container holding three sibling buttons — load, delete,
 * expand the error — rather than one button with `span role="button"`s
 * nested inside it. Nested interactive roles have no tab stop, no Enter/Space
 * handling and are invalid for assistive technology, so Delete and the error
 * toggle were mouse-only (#826).
 */
export function HistoryEntryRow({
  entry,
  runs,
  errorExpanded,
  onLoad,
  onRemove,
  onToggleError,
  onContextMenu,
}: {
  entry: HistoryEntry;
  /** How many consecutive identical runs this row stands for. */
  runs: number;
  errorExpanded: boolean;
  onLoad: () => void;
  onRemove: () => void;
  onToggleError: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  return (
    <li
      onContextMenu={onContextMenu}
      className="group flex flex-col gap-0.5 border-b border-[var(--color-border)] px-2.5 py-2 hover:bg-[var(--color-bg-tertiary)]"
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={onLoad}
          title="Insert into editor"
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
        >
          <pre className="line-clamp-2 w-full whitespace-pre-wrap break-all font-mono text-[11px] leading-tight text-[var(--color-text-primary)]">
            {entry.sql}
          </pre>
          <span className="flex w-full items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
            {entry.status === "success"
              ? <CheckCircle className="h-3 w-3 shrink-0 text-[var(--color-success)]" aria-label="Succeeded" />
              : <XCircle className="h-3 w-3 shrink-0 text-[var(--color-error)]" aria-label="Failed" />}
            <span className="truncate">{entry.connectionName}</span>
            <span className="flex items-center gap-0.5">
              <Clock className="h-2.5 w-2.5" />
              {formatRelativeTime(entry.executedAt)}
            </span>
            <span title={`${entry.executionTimeMs.toLocaleString()} ms`}>
              {formatDurationMs(entry.executionTimeMs)}
            </span>
            {entry.origin !== "editor" && (
              <span
                className="rounded bg-[var(--color-bg-tertiary)] px-1 text-[9px]"
                title={`Issued by the ${entry.origin}`}
              >
                {entry.origin}
              </span>
            )}
            {runs > 1 && (
              <span
                className="rounded bg-[var(--color-bg-tertiary)] px-1 text-[9px]"
                title={`Run ${runs} times in a row`}
              >
                ×{runs}
              </span>
            )}
            {entry.status === "success" && <span>{entry.rowCount} rows</span>}
            {entry.redacted && (
              <span
                className="rounded bg-[var(--color-bg-tertiary)] px-1 text-[9px] uppercase tracking-wide"
                title="A password was removed before this was saved, so it will not run as written."
              >
                redacted
              </span>
            )}
            {entry.status === "error" && entry.errorCode !== undefined && (
              <span className="font-mono text-[var(--color-error)]/80">
                {entry.errorCode}
                {entry.errorSqlState ? ` · ${entry.errorSqlState}` : ""}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          aria-label="Delete entry"
          title="Delete entry"
          onClick={onRemove}
          className="inline-flex shrink-0 rounded p-0.5 text-[var(--color-text-muted)] opacity-0 hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-error)] focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {entry.status === "error" && entry.error && (
        <button
          type="button"
          aria-expanded={errorExpanded}
          title={entry.error}
          onClick={onToggleError}
          className={cn(
            "block w-full rounded text-left text-[10px] text-[var(--color-error)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500",
            errorExpanded ? "whitespace-pre-wrap break-words" : "truncate",
          )}
        >
          {entry.error}
        </button>
      )}
    </li>
  );
}
