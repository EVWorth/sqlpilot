import { useState, useCallback, useEffect } from "react";
import {
  X,
  HardDriveUpload,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FolderOpen,
  FileText,
} from "lucide-react";
import { api } from "../../lib/tauri-api";
import { splitSqlStatements } from "../../lib/sql-import";
import { useConnectionStore } from "../../stores/connectionStore";
import type { DatabaseInfo } from "../../types";

interface RestoreDialogProps {
  isOpen: boolean;
  onClose: () => void;
  preSelectedConnectionId?: string;
  preSelectedDatabase?: string;
}

interface RestoreProgress {
  current: number;
  total: number;
  successCount: number;
  errorCount: number;
  errors: string[];
  done: boolean;
}

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
  const [fileSize, setFileSize] = useState<string | null>(null);
  const [statementCount, setStatementCount] = useState(0);
  const [preview, setPreview] = useState<string[]>([]);

  const [stopOnError, setStopOnError] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [progress, setProgress] = useState<RestoreProgress | null>(null);

  // Load databases when connection changes
  useEffect(() => {
    if (!connectionId) {
      setDatabases([]);
      return;
    }
    api
      .getDatabases(connectionId)
      .then(setDatabases)
      .catch((e) => { console.error("Failed to load databases for restore", e); setDatabases([]); });
  }, [connectionId]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setConnectionId(
        preSelectedConnectionId ?? selectedStoreConnectionId ?? "",
      );
      setDatabase(preSelectedDatabase ?? "");
      setFilePath(null);
      setFileSize(null);
      setStatementCount(0);
      setPreview([]);
      setProgress(null);
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

    try {
      const content = await api.readFileContents(path);
      const sizeKB = (content.length / 1024).toFixed(1);
      const sizeMB = (content.length / (1024 * 1024)).toFixed(1);
      setFileSize(
        content.length > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`,
      );

      const lines = content.split("\n").slice(0, 30);
      setPreview(lines);

      // Estimate statement count (count semicolons outside comments)
      const stmts = splitSqlStatements(content);
      setStatementCount(stmts.length);
    } catch (e) {
      console.error("Failed to read file:", e);
    }
  }, []);

  const handleRestore = useCallback(async () => {
    if (!connectionId || !database || !filePath) return;

    setRestoring(true);
    setProgress({
      current: 0,
      total: statementCount,
      successCount: 0,
      errorCount: 0,
      errors: [],
      done: false,
    });

    try {
      const content = await api.readFileContents(filePath);

      // Use the database
      await api.executeQuery(connectionId, `USE \`${database.replace(/`/g, "``")}\``);

      const statements = splitSqlStatements(content);
      let successCount = 0;
      let errorCount = 0;
      const errors: string[] = [];

      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i].trim();
        if (!stmt) continue;

        // Skip DELIMITER commands (handled by our splitter)
        if (stmt.toUpperCase().startsWith("DELIMITER")) continue;

        try {
          await api.executeQuery(connectionId, stmt);
          successCount++;
        } catch (e) {
          errorCount++;
          const errMsg = `Statement ${i + 1}: ${String(e).slice(0, 200)}`;
          errors.push(errMsg);

          if (stopOnError) {
            setProgress({
              current: i + 1,
              total: statements.length,
              successCount,
              errorCount,
              errors,
              done: true,
            });
            setRestoring(false);
            return;
          }
        }

        if (i % 10 === 0 || i === statements.length - 1) {
          setProgress({
            current: i + 1,
            total: statements.length,
            successCount,
            errorCount,
            errors,
            done: false,
          });
        }
      }

      setProgress({
        current: statements.length,
        total: statements.length,
        successCount,
        errorCount,
        errors,
        done: true,
      });
    } catch (e) {
      setProgress((prev) =>
        prev
          ? { ...prev, errors: [...prev.errors, String(e)], done: true }
          : null,
      );
    } finally {
      setRestoring(false);
    }
  }, [connectionId, database, filePath, statementCount, stopOnError]);

  if (!isOpen) return null;

  const selectClasses =
    "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none";
  const labelClasses =
    "block text-xs font-medium text-[var(--color-text-secondary)] mb-1";
  const checkboxLabelClasses =
    "flex items-center gap-2 text-xs text-[var(--color-text-secondary)] cursor-pointer";

  const isDone = progress?.done ?? false;
  const progressPct =
    progress && progress.total > 0
      ? (progress.current / progress.total) * 100
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
                  File size: {fileSize}
                </span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  • ~{statementCount.toLocaleString()} statements
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
            <label className={checkboxLabelClasses}>
              <input
                type="checkbox"
                checked={stopOnError}
                onChange={(e) => setStopOnError(e.target.checked)}
                disabled={restoring}
                className="accent-brand-500"
              />
              Stop on error
            </label>
          </div>

          {/* Progress */}
          {progress && (
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
                <span>
                  {isDone ? "Completed" : "Restoring..."}
                </span>
                <span>
                  {progress.current} / {progress.total}
                </span>
              </div>
              <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
                <div
                  className="h-full rounded-full bg-brand-500 transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="flex gap-4 text-[11px]">
                <span className="text-green-400">
                  ✓ {progress.successCount} succeeded
                </span>
                {progress.errorCount > 0 && (
                  <span className="text-red-400">
                    ✗ {progress.errorCount} failed
                  </span>
                )}
              </div>
              {progress.errors.length > 0 && (
                <div className="mt-2 max-h-24 overflow-auto rounded bg-red-500/10 p-2 text-[10px] text-red-400 font-mono">
                  {progress.errors.slice(-5).map((err, i) => (
                    <div key={i}>{err}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Done */}
          {isDone && progress && progress.errorCount === 0 && (
            <div className="flex items-center gap-2 rounded border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              Restore completed successfully! ({progress.successCount}{" "}
              statements executed)
            </div>
          )}
          {isDone && progress && progress.errorCount > 0 && (
            <div className="flex items-center gap-2 rounded border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
              <AlertCircle className="h-4 w-4" />
              Restore completed with {progress.errorCount} error(s)
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
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
            {restoring ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <HardDriveUpload className="h-3.5 w-3.5" />
            )}
            {restoring ? "Restoring..." : "Restore"}
          </button>
        </div>
      </div>
    </div>
  );
}
