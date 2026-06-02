import { useState, useCallback, useEffect, useRef } from "react";
import {
  X,
  HardDriveDownload,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FolderOpen,
} from "lucide-react";
import { api } from "../../lib/tauri-api";
import {
  generateBackup,
  defaultBackupOptions,
  type BackupOptions,
  type BackupProgress,
} from "../../lib/backup-generator";
import { useConnectionStore } from "../../stores/connectionStore";
import type { DatabaseInfo, TableInfo } from "../../types";

interface BackupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  preSelectedConnectionId?: string;
  preSelectedDatabase?: string;
}

type BackupContent = "structure_data" | "structure_only" | "data_only";

export function BackupDialog({
  isOpen,
  onClose,
  preSelectedConnectionId,
  preSelectedDatabase,
}: BackupDialogProps) {
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const selectedStoreConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );

  const [connectionId, setConnectionId] = useState(
    preSelectedConnectionId ?? selectedStoreConnectionId ?? "",
  );
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [database, setDatabase] = useState(preSelectedDatabase ?? "");
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [allTables, setAllTables] = useState(true);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());

  const [content, setContent] = useState<BackupContent>("structure_data");
  const [options, setOptions] = useState<BackupOptions>(defaultBackupOptions);

  const [filePath, setFilePath] = useState<string | null>(null);
  const [backing, setBacking] = useState(false);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const cancelRef = useRef({ current: false });

  // Load databases when connection changes
  useEffect(() => {
    if (!connectionId) {
      setDatabases([]);
      return;
    }
    api
      .getDatabases(connectionId)
      .then(setDatabases)
      .catch((e) => { console.error("Failed to load databases for backup", e); setDatabases([]); });
  }, [connectionId]);

  // Load tables when database changes
  useEffect(() => {
    if (!connectionId || !database) {
      setTables([]);
      return;
    }
    api
      .getTables(connectionId, database)
      .then((t) => {
        const baseTables = t.filter((tb) => tb.table_type !== "VIEW");
        setTables(baseTables);
        setSelectedTables(new Set(baseTables.map((tb) => tb.name)));
      })
      .catch((e) => { console.error("Failed to load tables for backup", e); setTables([]); });
  }, [connectionId, database]);

  // Set defaults on open
  useEffect(() => {
    if (isOpen) {
      setConnectionId(
        preSelectedConnectionId ?? selectedStoreConnectionId ?? "",
      );
      setDatabase(preSelectedDatabase ?? "");
      setDone(false);
      setError(null);
      setBacking(false);
      setProgress(null);
      setFilePath(null);
      cancelRef.current = { current: false };
    }
  }, [
    isOpen,
    preSelectedConnectionId,
    preSelectedDatabase,
    selectedStoreConnectionId,
  ]);

  const handlePickSavePath = useCallback(async () => {
    const now = new Date();
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "_",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    const defaultName = `${database || "backup"}_${ts}.sql`;

    const path = await api.pickSaveFile("Save Backup File", defaultName, [
      ["SQL Files", ["sql"]],
    ]);
    if (path) setFilePath(path);
  }, [database]);

  const handleBackup = useCallback(async () => {
    if (!connectionId || !database || !filePath) return;

    const tableList = allTables
      ? tables.map((t) => t.name)
      : tables.filter((t) => selectedTables.has(t.name)).map((t) => t.name);

    if (tableList.length === 0) {
      setError("No tables selected");
      return;
    }

    const resolvedOptions: BackupOptions = {
      ...options,
      includeStructure: content !== "data_only",
      includeData: content !== "structure_only",
    };

    setBacking(true);
    setError(null);
    setDone(false);
    cancelRef.current = { current: false };

    try {
      const sql = await generateBackup(
        connectionId,
        database,
        tableList,
        resolvedOptions,
        setProgress,
        cancelRef.current,
      );

      if (cancelRef.current.current) {
        setBacking(false);
        return;
      }

      await api.writeFileContents(filePath, sql);
      setDone(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBacking(false);
    }
  }, [
    connectionId,
    database,
    filePath,
    allTables,
    tables,
    selectedTables,
    content,
    options,
  ]);

  const handleCancel = useCallback(() => {
    cancelRef.current.current = true;
  }, []);

  if (!isOpen) return null;

  const selectClasses =
    "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none";
  const labelClasses =
    "block text-xs font-medium text-[var(--color-text-secondary)] mb-1";
  const checkboxLabelClasses =
    "flex items-center gap-2 text-xs text-[var(--color-text-secondary)] cursor-pointer";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative max-h-[85vh] w-[560px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <HardDriveDownload className="h-4 w-4 text-brand-400" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Backup Database
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
                disabled={backing}
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
                disabled={!connectionId || backing}
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

          {/* Table selection */}
          {database && tables.length > 0 && (
            <div>
              <label className={labelClasses}>Tables</label>
              <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2">
                <label className={checkboxLabelClasses + " mb-2"}>
                  <input
                    type="checkbox"
                    checked={allTables}
                    onChange={(e) => {
                      setAllTables(e.target.checked);
                      if (e.target.checked) {
                        setSelectedTables(new Set(tables.map((t) => t.name)));
                      }
                    }}
                    disabled={backing}
                    className="accent-brand-500"
                  />
                  All Tables ({tables.length})
                </label>
                {!allTables && (
                  <div className="max-h-32 overflow-y-auto space-y-0.5 ml-4">
                    {tables.map((t) => (
                      <label
                        key={t.name}
                        className={checkboxLabelClasses}
                      >
                        <input
                          type="checkbox"
                          checked={selectedTables.has(t.name)}
                          onChange={(e) => {
                            const next = new Set(selectedTables);
                            if (e.target.checked) next.add(t.name);
                            else next.delete(t.name);
                            setSelectedTables(next);
                          }}
                          disabled={backing}
                          className="accent-brand-500"
                        />
                        {t.name}
                        {t.row_count != null && (
                          <span className="text-[10px] text-[var(--color-text-muted)]">
                            ({t.row_count.toLocaleString()} rows)
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Content type */}
          <div>
            <label className={labelClasses}>Content</label>
            <div className="flex gap-4">
              {(
                [
                  ["structure_data", "Structure + Data"],
                  ["structure_only", "Structure Only"],
                  ["data_only", "Data Only"],
                ] as const
              ).map(([val, label]) => (
                <label key={val} className={checkboxLabelClasses}>
                  <input
                    type="radio"
                    name="backupContent"
                    value={val}
                    checked={content === val}
                    onChange={() => setContent(val)}
                    disabled={backing}
                    className="accent-brand-500"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/* Options */}
          <div>
            <label className={labelClasses}>Options</label>
            <div className="grid grid-cols-2 gap-2">
              <label className={checkboxLabelClasses}>
                <input
                  type="checkbox"
                  checked={options.dropTableIfExists}
                  onChange={(e) =>
                    setOptions((o) => ({
                      ...o,
                      dropTableIfExists: e.target.checked,
                    }))
                  }
                  disabled={backing}
                  className="accent-brand-500"
                />
                DROP TABLE IF EXISTS
              </label>
              <label className={checkboxLabelClasses}>
                <input
                  type="checkbox"
                  checked={options.includeCreateDatabase}
                  onChange={(e) =>
                    setOptions((o) => ({
                      ...o,
                      includeCreateDatabase: e.target.checked,
                    }))
                  }
                  disabled={backing}
                  className="accent-brand-500"
                />
                Include CREATE DATABASE
              </label>
              <label className={checkboxLabelClasses}>
                <input
                  type="checkbox"
                  checked={options.addTableLocks}
                  onChange={(e) =>
                    setOptions((o) => ({
                      ...o,
                      addTableLocks: e.target.checked,
                    }))
                  }
                  disabled={backing}
                  className="accent-brand-500"
                />
                Add table locks
              </label>
              <label className={checkboxLabelClasses}>
                <input
                  type="checkbox"
                  checked={options.includeAutoIncrement}
                  onChange={(e) =>
                    setOptions((o) => ({
                      ...o,
                      includeAutoIncrement: e.target.checked,
                    }))
                  }
                  disabled={backing}
                  className="accent-brand-500"
                />
                AUTO_INCREMENT values
              </label>
              <label className={checkboxLabelClasses}>
                <input
                  type="checkbox"
                  checked={options.includeViews}
                  onChange={(e) =>
                    setOptions((o) => ({
                      ...o,
                      includeViews: e.target.checked,
                    }))
                  }
                  disabled={backing}
                  className="accent-brand-500"
                />
                Include views
              </label>
              <label className={checkboxLabelClasses}>
                <input
                  type="checkbox"
                  checked={options.includeRoutines}
                  onChange={(e) =>
                    setOptions((o) => ({
                      ...o,
                      includeRoutines: e.target.checked,
                    }))
                  }
                  disabled={backing}
                  className="accent-brand-500"
                />
                Include procedures/functions
              </label>
              <label className={checkboxLabelClasses}>
                <input
                  type="checkbox"
                  checked={options.includeTriggers}
                  onChange={(e) =>
                    setOptions((o) => ({
                      ...o,
                      includeTriggers: e.target.checked,
                    }))
                  }
                  disabled={backing}
                  className="accent-brand-500"
                />
                Include triggers
              </label>
            </div>
          </div>

          {/* Insert format */}
          <div>
            <label className={labelClasses}>Insert Format</label>
            <div className="flex items-center gap-4">
              <label className={checkboxLabelClasses}>
                <input
                  type="radio"
                  name="insertFormat"
                  checked={!options.multiRowInserts}
                  onChange={() =>
                    setOptions((o) => ({ ...o, multiRowInserts: false }))
                  }
                  disabled={backing}
                  className="accent-brand-500"
                />
                Single row
              </label>
              <label className={checkboxLabelClasses}>
                <input
                  type="radio"
                  name="insertFormat"
                  checked={options.multiRowInserts}
                  onChange={() =>
                    setOptions((o) => ({ ...o, multiRowInserts: true }))
                  }
                  disabled={backing}
                  className="accent-brand-500"
                />
                Multi-row, batch size:
              </label>
              {options.multiRowInserts && (
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={options.insertBatchSize}
                  onChange={(e) =>
                    setOptions((o) => ({
                      ...o,
                      insertBatchSize: Math.max(
                        1,
                        parseInt(e.target.value) || 100,
                      ),
                    }))
                  }
                  disabled={backing}
                  className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
                />
              )}
            </div>
          </div>

          {/* Output file */}
          <div>
            <label className={labelClasses}>Output File</label>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={filePath ?? ""}
                placeholder="Choose a file location..."
                className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
              />
              <button
                onClick={handlePickSavePath}
                disabled={backing}
                className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Browse
              </button>
            </div>
          </div>

          {/* Progress */}
          {backing && progress && (
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
                <span>{progress.phase}</span>
                {progress.totalTables > 0 && (
                  <span>
                    {progress.currentTable} / {progress.totalTables}
                  </span>
                )}
              </div>
              {progress.totalTables > 0 && (
                <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-all"
                    style={{
                      width: `${(progress.currentTable / progress.totalTables) * 100}%`,
                    }}
                  />
                </div>
              )}
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {progress.tableName && (
                  <span>Table: {progress.tableName}</span>
                )}
                {progress.rowsExported > 0 && (
                  <span className="ml-3">
                    {progress.rowsExported.toLocaleString()} rows exported
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Done message */}
          {done && (
            <div className="flex items-center gap-2 rounded border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              Backup completed successfully!
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          {backing ? (
            <button
              onClick={handleCancel}
              className="rounded border border-red-500/30 bg-red-500/10 px-4 py-1.5 text-xs text-red-400 hover:bg-red-500/20"
            >
              Cancel
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="rounded border border-[var(--color-border)] px-4 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
              >
                Close
              </button>
              <button
                onClick={handleBackup}
                disabled={!connectionId || !database || !filePath}
                className="flex items-center gap-1.5 rounded bg-brand-600 px-4 py-1.5 text-xs text-white hover:bg-brand-500 disabled:opacity-50"
              >
                {backing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <HardDriveDownload className="h-3.5 w-3.5" />
                )}
                Backup
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
