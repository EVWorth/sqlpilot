import { AlertCircle, CheckCircle2, FileText, FolderOpen, HardDriveUpload, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { attachProgress, formatBytes, formatElapsed } from "../../lib/backup-progress";
import { events, type RestoreOptions, type RestoreProgress, type RestoreSummary } from "../../lib/bindings";
import { api } from "../../lib/tauri-api";
import { useConnectionStore } from "../../stores/connectionStore";
import { confirmDestructive } from "../../stores/productionGuardStore";
import type { DatabaseInfo } from "../../types";

interface RestoreDialogProps {
  isOpen: boolean;
  onClose: () => void;
  preSelectedConnectionId?: string;
  preSelectedDatabase?: string;
}

/** How much of a dump is read to show a preview of it. */
const PREVIEW_BYTES = 64 * 1024;

export function RestoreDialog({
  isOpen,
  onClose,
  preSelectedConnectionId,
  preSelectedDatabase,
}: RestoreDialogProps) {
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const selectedStoreConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );

  const [connectionId, setConnectionId] = useState(
    preSelectedConnectionId ?? selectedStoreConnectionId ?? "",
  );
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [database, setDatabase] = useState(preSelectedDatabase ?? "");

  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileBytes, setFileBytes] = useState<number | null>(null);
  const [preview, setPreview] = useState<string[]>([]);

  const [options, setOptions] = useState<RestoreOptions>({
    stopOnError: true,
    disableForeignKeyChecks: true,
    wrapInTransaction: true,
  });
  const [restoring, setRestoring] = useState(false);
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  const [summary, setSummary] = useState<RestoreSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restoreIdRef = useRef<string | null>(null);

  // Load databases when connection changes
  useEffect(() => {
    if (!connectionId) {
      setDatabases([]);
      return;
    }
    api
      .getDatabases(connectionId)
      .then(setDatabases)
      .catch((e) => {
        console.error("Failed to load databases for restore", e);
        setDatabases([]);
      });
  }, [connectionId]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setConnectionId(
        preSelectedConnectionId ?? selectedStoreConnectionId ?? "",
      );
      setDatabase(preSelectedDatabase ?? "");
      setFilePath(null);
      setFileBytes(null);
      setPreview([]);
      setProgress(null);
      setSummary(null);
      setError(null);
      setRestoring(false);
    }
  }, [
    isOpen,
    preSelectedConnectionId,
    preSelectedDatabase,
    selectedStoreConnectionId,
  ]);

  const handlePickFile = useCallback(async () => {
    const path = await api.pickFile("Select SQL Backup File", [
      ["SQL Files", ["sql"]],
      ["All Files", ["*"]],
    ]);
    if (!path) return;

    setFilePath(path);
    setSummary(null);
    setError(null);

    try {
      // Only the head of it. Reading a multi-gigabyte dump into the renderer
      // to draw thirty lines of preview is what the streaming restore exists
      // to avoid (#358).
      const head = await api.readFileHead(path, PREVIEW_BYTES);
      setFileBytes(head.totalBytes);
      setPreview(head.text.split("\n").slice(0, 30));
    } catch (e) {
      setError(String(e));
      setFileBytes(null);
      setPreview([]);
    }
  }, []);

  const handleRestore = useCallback(async () => {
    if (!connectionId || !database || !filePath) return;

    // Once for the restore, not per statement (#588). A dump is the most
    // destructive thing this app runs — it typically drops and recreates
    // every table it touches — and it was the one path with no gate at all.
    if (
      !(await confirmDestructive({
        connectionId,
        sql: [],
        action: `Restore ${filePath.split(/[\\/]/).pop()} into \`${database}\`?`,
        detail: "A dump usually drops and recreates the objects it restores.",
      }))
    ) {
      return;
    }

    const id = crypto.randomUUID();
    restoreIdRef.current = id;
    setRestoring(true);
    setProgress(null);
    setSummary(null);
    setError(null);

    // A progress listener that cannot attach is not a reason to refuse to
    // run: the work still happens, the bar just does not move.
    const unlisten = await attachProgress(() =>
      events.restoreProgressEvent.listen((e) => {
        if (e.payload.restoreId === id) setProgress(e.payload.progress);
      })
    );

    try {
      setSummary(await api.restoreDatabase(id, connectionId, database, filePath, options));
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      restoreIdRef.current = null;
      setRestoring(false);
    }
  }, [connectionId, database, filePath, options]);

  const handleCancel = useCallback(() => {
    const id = restoreIdRef.current;
    // Stops at the next statement and rolls back whatever has not already
    // been committed. Anything the file had already committed stays.
    if (id) void api.cancelBackup(id).catch(() => {});
  }, []);

  if (!isOpen) return null;

  const selectClasses =
    "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none";
  const labelClasses = "block text-xs font-medium text-[var(--color-text-secondary)] mb-1";
  const checkboxLabelClasses = "flex items-center gap-2 text-xs text-[var(--color-text-secondary)] cursor-pointer";

  // By bytes of the file rather than by statement: the statement count is
  // not known until the file has been read, which is the thing being done.
  const progressPct = progress && progress.totalBytes > 0
    ? Math.min(100, (progress.bytesRead / progress.totalBytes) * 100)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative max-h-[85vh] w-[520px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <HardDriveUpload className="h-4 w-4 text-brand-400" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Restore Database
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {/* File picker */}
          <div>
            <label className={labelClasses}>SQL File</label>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={filePath ?? ""}
                placeholder="Select a SQL backup file..."
                className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
              />
              <button
                onClick={handlePickFile}
                disabled={restoring}
                className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Browse
              </button>
            </div>
          </div>

          {/* File info */}
          {filePath && (
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
                <span className="text-xs text-[var(--color-text-secondary)]">
                  File size: {fileBytes === null ? "unknown" : formatBytes(fileBytes)}
                </span>
              </div>
              {preview.length > 0 && (
                <pre className="max-h-24 overflow-auto rounded bg-[var(--color-bg-primary)] p-2 text-[10px] text-[var(--color-text-muted)] font-mono">
                  {preview.join("\n")}
                </pre>
              )}
            </div>
          )}

          {/* Connection + Database */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClasses}>Connection</label>
              <select
                className={selectClasses}
                value={connectionId}
                onChange={(e) => {
                  setConnectionId(e.target.value);
                  setDatabase("");
                }}
                disabled={restoring}
              >
                <option value="">Select connection...</option>
                {activeConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClasses}>Database</label>
              <select
                className={selectClasses}
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                disabled={!connectionId || restoring}
              >
                <option value="">Select database...</option>
                {databases.map((db) => (
                  <option key={db.name} value={db.name}>
                    {db.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Options */}
          <div>
            <label className={labelClasses}>Options</label>
            <div className="space-y-1.5">
              <label className={checkboxLabelClasses}>
                <input
                  type="checkbox"
                  checked={options.stopOnError}
                  onChange={(e) => setOptions((o) => ({ ...o, stopOnError: e.target.checked }))}
                  disabled={restoring}
                  className="accent-brand-500"
                />
                Stop on error
              </label>
              <label
                className={checkboxLabelClasses}
                title="A file whose tables are in the wrong order restores anyway. Turned back on when the restore ends."
              >
                <input
                  type="checkbox"
                  checked={options.disableForeignKeyChecks}
                  onChange={(e) => setOptions((o) => ({ ...o, disableForeignKeyChecks: e.target.checked }))}
                  disabled={restoring}
                  className="accent-brand-500"
                />
                Ignore foreign-key order
              </label>
              <label
                className={checkboxLabelClasses}
                title="Makes a data-only file all-or-nothing. It cannot make a file containing CREATE or DROP atomic: MySQL commits before every DDL statement."
              >
                <input
                  type="checkbox"
                  checked={options.wrapInTransaction}
                  onChange={(e) => setOptions((o) => ({ ...o, wrapInTransaction: e.target.checked }))}
                  disabled={restoring}
                  className="accent-brand-500"
                />
                Run in a transaction
              </label>
            </div>
          </div>

          {/* Progress */}
          {progress && !summary && (
            <div
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3"
              role="status"
              aria-live="polite"
            >
              <div className="mb-2 flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
                <span>Restoring…</span>
                <span>{Math.round(progressPct)}%</span>
              </div>
              <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
                <div
                  className="h-full rounded-full bg-brand-500 transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                <span className="text-green-400">✓ {progress.statementsRun} statements</span>
                {progress.statementsFailed > 0 && (
                  <span className="text-red-400">✗ {progress.statementsFailed} failed</span>
                )}
                <span className="text-[var(--color-text-muted)]">
                  {formatBytes(progress.bytesRead)} of {formatBytes(progress.totalBytes)}
                </span>
                <span className="text-[var(--color-text-muted)]">
                  {formatElapsed(progress.elapsedMs)} elapsed
                </span>
              </div>
            </div>
          )}

          {
            /* What happened. The old dialog said "completed" or "completed
              with N errors" and never said whether the database had been
              changed, which is the thing a user has to know. */
          }
          {summary && (
            <div
              className={summary.statementsFailed === 0
                ? "rounded border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-400"
                : "rounded border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400"}
            >
              <div className="flex items-center gap-2">
                {summary.statementsFailed === 0
                  ? <CheckCircle2 className="h-4 w-4" />
                  : <AlertCircle className="h-4 w-4" />}
                {summary.cancelled
                  ? "Restore cancelled"
                  : summary.statementsFailed === 0
                  ? `Restore complete — ${summary.statementsRun.toLocaleString()} statements in ${
                    formatElapsed(summary.elapsedMs)
                  }.`
                  : `Stopped after ${summary.statementsFailed} error(s); ${summary.statementsRun} statements had run.`}
              </div>
              {(summary.cancelled || summary.statementsFailed > 0) && (
                <div className="mt-1 ml-6 text-[11px]">
                  {summary.partiallyApplied
                    ? summary.rolledBack
                      ? "Rolled back, but part of the file had already been applied: MySQL commits before every CREATE, DROP or ALTER, so the structural changes stand."
                      : "The database has been partly changed. Check it before running the file again."
                    : "Rolled back — the database is as it was."}
                </div>
              )}
              {summary.errors.length > 0 && (
                <div className="mt-2 max-h-24 overflow-auto rounded bg-red-500/10 p-2 font-mono text-[10px] text-red-400">
                  {summary.errors.slice(0, 10).map((err) => <div key={err}>{err}</div>)}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          {restoring && (
            <button
              onClick={handleCancel}
              className="rounded border border-red-500/30 bg-red-500/10 px-4 py-1.5 text-xs text-red-400 hover:bg-red-500/20"
            >
              Cancel
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded border border-[var(--color-border)] px-4 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
          >
            Close
          </button>
          <button
            onClick={handleRestore}
            disabled={!connectionId || !database || !filePath || restoring}
            className="flex items-center gap-1.5 rounded bg-brand-600 px-4 py-1.5 text-xs text-white hover:bg-brand-500 disabled:opacity-50"
          >
            {restoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HardDriveUpload className="h-3.5 w-3.5" />}
            {restoring ? "Restoring..." : "Restore"}
          </button>
        </div>
      </div>
    </div>
  );
}
