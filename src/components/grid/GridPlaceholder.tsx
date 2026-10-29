import { AlertCircle, CircleSlash, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { FailedStatement } from "../../stores/resultStore";
import type { QueryResult } from "../../types";

/**
 * What the results pane shows when there is no grid to draw: running, failed,
 * a statement that returned a count, or nothing run yet.
 *
 * Split out of ResultsGrid (#406). Four early returns that each end the
 * render sat above the component's real work, which made the shape of the
 * file harder to see than the states themselves are.
 */

export interface GridPlaceholderProps {
  isExecuting: boolean;
  error: string | null;
  result: QueryResult | undefined;
  /** When the running statement started; drives the elapsed-time counter. */
  startedAt?: number | null;
  /** Set when the user cancelled the last run (#850). */
  cancelledAfterMs?: number | null;
  /** Which statement of a script the error came from (#845). */
  failedStatement?: FailedStatement | null;
}

/** Seconds with one decimal: "1.2 s". */
export function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Ticks while a statement runs, so a slow query visibly is one. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{formatElapsed(Math.max(0, now - startedAt))}</span>;
}

/**
 * The caller decides there is nothing to draw; this decides what to say about
 * it. Returns null only if called when there *is* a grid to render, which the
 * caller's own guard rules out.
 */
export function GridPlaceholder({
  isExecuting,
  error,
  result,
  startedAt,
  cancelledAfterMs,
  failedStatement,
}: GridPlaceholderProps) {
  if (isExecuting) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Executing query...
        {typeof startedAt === "number" && <Elapsed startedAt={startedAt} />}
      </div>
    );
  }

  // The user's own cancel is what they asked for, not a failure (#850).
  if (typeof cancelledAfterMs === "number" && !error) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center gap-2 text-sm text-[var(--color-text-secondary)]"
      >
        <CircleSlash className="h-4 w-4" />
        Cancelled after {formatElapsed(cancelledAfterMs)}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-4">
        <QueryErrorBox error={error} failedStatement={failedStatement} className="max-w-lg" />
      </div>
    );
  }

  if (!result || result.columns.length === 0) {
    // A statement that changed rows returned no columns, which is not the
    // same as nothing having been run.
    if (result && result.rows_affected >= 0) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">
          Query executed. {result.rows_affected} row(s) affected. ({result.execution_time_ms}ms)
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
        Execute a query to see results
      </div>
    );
  }

  return null;
}

/** What failed, and where in the script: "Statement 2 of 3 failed (1146)" (#845). */
export function errorTitle(failed: FailedStatement | null | undefined): string {
  if (!failed) return "Query Error";
  const where = failed.count > 1 ? `Statement ${failed.index + 1} of ${failed.count} failed` : "Statement failed";
  return failed.code !== null ? `${where} (${failed.code})` : where;
}

/** The error box, shared by the placeholder and the banner over earlier results. */
export function QueryErrorBox({
  error,
  failedStatement,
  className,
}: {
  error: string;
  failedStatement?: FailedStatement | null;
  className?: string;
}) {
  return (
    <div role="alert" className={`rounded border edge-error surface-error-strong p-4 ${className ?? ""}`}>
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-error)]">
        <AlertCircle className="h-4 w-4" />
        {errorTitle(failedStatement)}
      </div>
      <pre className="mt-2 whitespace-pre-wrap text-xs text-[var(--color-error)]">{error}</pre>
      {failedStatement?.sql && (
        <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-bg-primary)] p-2 font-mono text-xs text-[var(--color-text-secondary)]">
          {failedStatement.sql}
        </pre>
      )}
    </div>
  );
}
