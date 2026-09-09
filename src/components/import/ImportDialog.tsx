import { AlertCircle, AlertTriangle, CheckCircle2, FileText, Loader2, Table2, Upload, X } from "lucide-react";
import { useCallback, useState } from "react";
import { type CsvParseOptions, parseCSV } from "../../lib/csv-parser";
import { generateBatchInsert, splitSqlStatements } from "../../lib/sql-import";
import { isDestructiveStatement } from "../../lib/sql-safety";
import { api } from "../../lib/tauri-api";
import { confirmDestructive } from "../../stores/productionGuardStore";
import type { ColumnInfo, TableInfo } from "../../types";

interface ImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string;
  database: string;
}

type ImportMode = "sql" | "csv";

interface ImportProgress {
  current: number;
  total: number;
  successCount: number;
  errorCount: number;
  errors: string[];
  done: boolean;
  /** Set when the run stopped early, so the summary can say it did. */
  stoppedAt: number | null;
}

export function ImportDialog({
  isOpen,
  onClose,
  connectionId,
  database,
}: ImportDialogProps) {
  const [mode, setMode] = useState<ImportMode>("sql");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [importing, setImporting] = useState(false);

  // SQL mode state
  const [sqlPreview, setSqlPreview] = useState<string[]>([]);
  const [destructiveStatements, setDestructiveStatements] = useState<string[]>([]);
  // Default on: running the rest of a dump after one statement failed applies
  // it to a database in a state the file did not expect (#365).
  const [stopOnError, setStopOnError] = useState(true);
  const [statementCount, setStatementCount] = useState(0);

  // CSV mode state
  const [csvOptions, setCsvOptions] = useState<CsvParseOptions>({
    delimiter: ",",
    hasHeader: true,
    quoteChar: "\"",
  });
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  // Which cells the file wrote bare, so `,,` and `,"",` stay distinct (#578).
  const [csvBareEmpty, setCsvBareEmpty] = useState<boolean[][]>([]);
  const [csvPreviewRows, setCsvPreviewRows] = useState<string[][]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [targetTable, setTargetTable] = useState("");
  const [targetColumns, setTargetColumns] = useState<ColumnInfo[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>(
    {},
  );

  const resetState = useCallback(() => {
    setFilePath(null);
    setFileContent(null);
    setProgress(null);
    setImporting(false);
    setSqlPreview([]);
    setDestructiveStatements([]);
    setStatementCount(0);
    setCsvHeaders([]);
    setCsvRows([]);
    setCsvBareEmpty([]);
    setCsvPreviewRows([]);
    setTargetTable("");
    setTargetColumns([]);
    setColumnMapping({});
  }, []);

  const handlePickFile = useCallback(async () => {
    try {
      const filters: [string, string[]][] = mode === "sql"
        ? [["SQL Files", ["sql"]]]
        : [["CSV Files", ["csv", "tsv", "txt"]]];

      const path = await api.pickFile(
        mode === "sql" ? "Select SQL File" : "Select CSV File",
        filters,
      );

      if (!path) return;

      const content = await api.readFileContents(path);
      setFilePath(path);
      setFileContent(content);

      if (mode === "sql") {
        const lines = content.split("\n").slice(0, 50);
        setSqlPreview(lines);
        const stmts = splitSqlStatements(content);
        setStatementCount(stmts.length);
        // A dump's DROP TABLE can sit at line 5,000. Counting them up front
        // means the user is told what the file does without reading it (#367).
        setDestructiveStatements(stmts.filter(isDestructiveStatement));
      } else {
        parseCsvContent(content, csvOptions);
        await loadTables();
      }
    } catch (e) {
      console.error("Failed to pick file:", e);
    }
  }, [mode, csvOptions, connectionId, database]); // eslint-disable-line react-hooks/exhaustive-deps

  const parseCsvContent = useCallback(
    (content: string, options: CsvParseOptions) => {
      try {
        const result = parseCSV(content, options);
        setCsvHeaders(result.headers);
        setCsvRows(result.rows);
        // Defaulted: a result without the field falls back to treating every
        // empty cell as absent, which is what callers got before it existed.
        setCsvBareEmpty(result.bareEmpty ?? []);
        setCsvPreviewRows(result.rows.slice(0, 10));
      } catch (e) {
        console.error("CSV parse error:", e);
      }
    },
    [],
  );

  const loadTables = useCallback(async () => {
    try {
      const tableList = await api.getTables(connectionId, database);
      setTables(tableList);
    } catch (e) {
      console.error("Failed to load tables:", e);
    }
  }, [connectionId, database]);

  const handleTargetTableChange = useCallback(
    async (table: string) => {
      setTargetTable(table);
      if (!table) {
        setTargetColumns([]);
        setColumnMapping({});
        return;
      }
      try {
        const cols = await api.getColumns(connectionId, database, table);
        setTargetColumns(cols);
        // Auto-map by name (case-insensitive)
        const mapping: Record<string, string> = {};
        for (const csvCol of csvHeaders) {
          const match = cols.find(
            (c) => c.name.toLowerCase() === csvCol.toLowerCase(),
          );
          if (match) {
            mapping[csvCol] = match.name;
          }
        }
        setColumnMapping(mapping);
      } catch (e) {
        console.error("Failed to load columns:", e);
      }
    },
    [connectionId, database, csvHeaders],
  );

  const handleCsvOptionChange = useCallback(
    (key: keyof CsvParseOptions, value: string | boolean) => {
      const newOptions = { ...csvOptions, [key]: value };
      setCsvOptions(newOptions);
      if (fileContent) {
        parseCsvContent(fileContent, newOptions);
      }
    },
    [csvOptions, fileContent, parseCsvContent],
  );

  const handleImportSql = useCallback(async () => {
    if (!fileContent) return;
    setImporting(true);
    const statements = splitSqlStatements(fileContent);
    const prog: ImportProgress = {
      current: 0,
      total: statements.length,
      successCount: 0,
      errorCount: 0,
      errors: [],
      done: false,
      stoppedAt: null,
    };
    setProgress({ ...prog });

    // Once for the run rather than per statement: a dump can hold thousands,
    // and a prompt on each would be held down rather than read (#588).
    if (
      !(await confirmDestructive({
        connectionId,
        sql: statements,
        action: `Import ${statements.length} statement(s) into \`${database}\`?`,
        detail: "Some of them drop or alter existing objects.",
      }))
    ) {
      setImporting(false);
      return;
    }

    // Every error used to be counted and the run carried on to the end, so a
    // dump whose CREATE TABLE failed still executed all of its INSERTs
    // against whatever was already there. Stopping is the default now; going
    // on is a choice (#365).
    for (let i = 0; i < statements.length; i++) {
      prog.current = i + 1;
      try {
        await api.executeQuery(connectionId, statements[i]);
        prog.successCount++;
      } catch (e) {
        prog.errorCount++;
        prog.errors.push(
          `Statement ${i + 1}: ${String(e).slice(0, 200)}`,
        );
        if (stopOnError) {
          prog.stoppedAt = i + 1;
          setProgress({ ...prog });
          break;
        }
      }
      setProgress({ ...prog });
    }

    prog.done = true;
    setProgress({ ...prog });
    setImporting(false);
  }, [fileContent, connectionId, stopOnError]);

  const handleImportCsv = useCallback(async () => {
    if (!targetTable || csvRows.length === 0) return;
    setImporting(true);

    // Build mapped columns and rows
    const mappedCsvCols = csvHeaders.filter((h) => columnMapping[h]);
    const dbCols = mappedCsvCols.map((h) => columnMapping[h]);
    const colIndices = mappedCsvCols.map((h) => csvHeaders.indexOf(h));
    const mappedRows = csvRows.map((row) => colIndices.map((idx) => row[idx] ?? ""));
    // Reordered the same way as the cells they describe.
    const mappedBare = csvBareEmpty.map((row) => colIndices.map((idx) => row[idx] ?? true));

    const batchSize = 100;
    const statements = generateBatchInsert(
      targetTable,
      dbCols,
      mappedRows,
      batchSize,
      mappedBare,
    );

    const totalRows = csvRows.length;
    const prog: ImportProgress = {
      current: 0,
      total: totalRows,
      successCount: 0,
      errorCount: 0,
      errors: [],
      done: false,
      stoppedAt: null,
    };
    setProgress({ ...prog });

    for (let i = 0; i < statements.length; i++) {
      const batchStart = i * batchSize;
      const batchEnd = Math.min(batchStart + batchSize, totalRows);
      const batchRows = batchEnd - batchStart;
      try {
        await api.executeQuery(connectionId, statements[i]);
        prog.successCount += batchRows;
      } catch (e) {
        prog.errorCount += batchRows;
        prog.errors.push(
          `Rows ${batchStart + 1}-${batchEnd}: ${String(e).slice(0, 200)}`,
        );
      }
      prog.current = batchEnd;
      setProgress({ ...prog });
    }

    prog.done = true;
    setProgress({ ...prog });
    setImporting(false);
  }, [targetTable, csvHeaders, csvRows, csvBareEmpty, columnMapping, connectionId]);

  const handleClose = useCallback(() => {
    if (!importing) {
      resetState();
      onClose();
    }
  }, [importing, resetState, onClose]);

  if (!isOpen) return null;

  const fileName = filePath?.split(/[/\\]/).pop() ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-brand-400" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Import Data
            </h2>
          </div>
          <button
            onClick={handleClose}
            disabled={importing}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-[var(--color-border)]">
          <button
            onClick={() => {
              if (!importing) {
                setMode("sql");
                resetState();
              }
            }}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors ${
              mode === "sql"
                ? "border-b-2 border-brand-400 text-brand-400"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            <FileText className="h-3.5 w-3.5" />
            SQL File
          </button>
          <button
            onClick={() => {
              if (!importing) {
                setMode("csv");
                resetState();
              }
            }}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors ${
              mode === "csv"
                ? "border-b-2 border-brand-400 text-brand-400"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            <Table2 className="h-3.5 w-3.5" />
            CSV File
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* File picker */}
          <div className="mb-4">
            <button
              onClick={handlePickFile}
              disabled={importing}
              className="flex items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-40"
            >
              <Upload className="h-3.5 w-3.5" />
              {fileName ?? "Select file..."}
            </button>
          </div>

          {/* SQL Mode */}
          {mode === "sql" && fileContent && (
            <div className="space-y-3">
              <div className="text-xs text-[var(--color-text-muted)]">
                {statementCount} statement{statementCount !== 1 ? "s" : ""} detected
              </div>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  aria-label="Stop at the first error"
                  checked={stopOnError}
                  onChange={(e) => setStopOnError(e.target.checked)}
                  className="mt-0.5 h-3 w-3 accent-brand-500"
                />
                <span className="text-[11px] text-[var(--color-text-secondary)]">
                  Stop at the first error
                  {
                    /*
                    Said plainly rather than implied. A dump's CREATE, DROP and
                    ALTER each commit as they run, so what has already been
                    applied when the import stops cannot be undone — wrapping
                    the run in a transaction would not change that (#365).
                  */
                  }
                  <span className="mt-0.5 block text-[10px] text-[var(--color-text-muted)]">
                    Statements that already ran stay applied either way — SQL files containing CREATE, DROP or ALTER
                    cannot be rolled back.
                  </span>
                </span>
              </label>
              {destructiveStatements.length > 0 && (
                <div
                  data-testid="destructive-warning"
                  className="rounded border border-amber-600 bg-amber-900/20 px-3 py-2 text-[11px] text-amber-300"
                >
                  <p className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {destructiveStatements.length} statement
                    {destructiveStatements.length !== 1 ? "s" : ""} in this file will drop or overwrite data
                  </p>
                  <ul className="mt-1.5 space-y-0.5 font-mono">
                    {destructiveStatements.slice(0, 5).map((stmt, i) => (
                      <li key={i} className="truncate" title={stmt}>
                        {stmt.trim().slice(0, 120)}
                      </li>
                    ))}
                  </ul>
                  {destructiveStatements.length > 5 && (
                    <p className="mt-1 text-amber-400/80">
                      and {destructiveStatements.length - 5} more
                    </p>
                  )}
                </div>
              )}
              <div className="max-h-48 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2">
                <pre className="text-[11px] text-[var(--color-text-secondary)] whitespace-pre-wrap font-mono">
                  {sqlPreview.join("\n")}
                  {sqlPreview.length >= 50 && "\n..."}
                </pre>
              </div>
            </div>
          )}

          {/* CSV Mode */}
          {mode === "csv" && (
            <>
              {/* CSV Options */}
              {fileContent && (
                <div className="mb-4 space-y-3">
                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                      Delimiter:
                      <select
                        value={csvOptions.delimiter}
                        onChange={(e) => handleCsvOptionChange("delimiter", e.target.value)}
                        disabled={importing}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs"
                      >
                        <option value=",">Comma (,)</option>
                        <option value="	">Tab</option>
                        <option value="|">Pipe (|)</option>
                        <option value=";">Semicolon (;)</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                      Quote:
                      <select
                        value={csvOptions.quoteChar}
                        onChange={(e) => handleCsvOptionChange("quoteChar", e.target.value)}
                        disabled={importing}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs"
                      >
                        <option value={"\""}>Double quote (&quot;)</option>
                        <option value="'">Single quote (&apos;)</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                      <input
                        type="checkbox"
                        checked={csvOptions.hasHeader}
                        onChange={(e) => handleCsvOptionChange("hasHeader", e.target.checked)}
                        disabled={importing}
                        className="rounded"
                      />
                      Has header row
                    </label>
                  </div>

                  {/* CSV Preview */}
                  {csvPreviewRows.length > 0 && (
                    <div className="max-h-48 overflow-auto rounded border border-[var(--color-border)]">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="bg-[var(--color-bg-tertiary)]">
                            {csvHeaders.map((h, i) => (
                              <th
                                key={i}
                                className="border-b border-r border-[var(--color-border)] px-2 py-1 text-left font-medium text-[var(--color-text-secondary)]"
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {csvPreviewRows.map((row, ri) => (
                            <tr key={ri}>
                              {row.map((cell, ci) => (
                                <td
                                  key={ci}
                                  className="border-b border-r border-[var(--color-border)] px-2 py-1 text-[var(--color-text-muted)]"
                                >
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {csvRows.length > 10 && (
                        <div className="px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
                          Showing 10 of {csvRows.length} rows
                        </div>
                      )}
                    </div>
                  )}

                  {/* Target table */}
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                      Target table:
                      <select
                        value={targetTable}
                        onChange={(e) => handleTargetTableChange(e.target.value)}
                        disabled={importing}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs"
                      >
                        <option value="">Select table...</option>
                        {tables.map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    {/* Column mapping */}
                    {targetColumns.length > 0 && (
                      <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2">
                        <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                          Column Mapping
                        </div>
                        <div className="space-y-1">
                          {csvHeaders.map((csvCol) => (
                            <div
                              key={csvCol}
                              className="flex items-center gap-2 text-xs"
                            >
                              <span className="w-32 truncate text-[var(--color-text-secondary)]">
                                {csvCol}
                              </span>
                              <span className="text-[var(--color-text-muted)]">
                                →
                              </span>
                              <select
                                value={columnMapping[csvCol] ?? ""}
                                onChange={(e) =>
                                  setColumnMapping((prev) => ({
                                    ...prev,
                                    [csvCol]: e.target.value,
                                  }))}
                                disabled={importing}
                                className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-0.5 text-xs"
                              >
                                <option value="">(skip)</option>
                                {targetColumns.map((c) => (
                                  <option key={c.name} value={c.name}>
                                    {c.name} ({c.column_type})
                                  </option>
                                ))}
                              </select>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Progress */}
          {progress && (
            <div className="mt-4 space-y-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[var(--color-text-secondary)]">
                  {progress.done
                    ? "Import complete"
                    : mode === "sql"
                    ? `Executing statement ${progress.current} of ${progress.total}...`
                    : `Importing row ${progress.current} of ${progress.total}...`}
                </span>
                {importing && <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-400" />}
              </div>

              {/* Progress bar */}
              <div className="h-1.5 w-full rounded-full bg-[var(--color-bg-tertiary)]">
                <div
                  className="h-full rounded-full bg-brand-400 transition-all"
                  style={{
                    width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>

              {/* Results */}
              <div className="flex items-center gap-4 text-xs">
                <span className="flex items-center gap-1 text-green-400">
                  <CheckCircle2 className="h-3 w-3" />
                  {progress.successCount} {mode === "sql" ? "succeeded" : "rows imported"}
                </span>
                {progress.stoppedAt !== null && (
                  <span data-testid="stopped-at" className="text-[11px] text-amber-400">
                    Stopped at statement {progress.stoppedAt} of {progress.total}. {progress.successCount}{" "}
                    already applied.
                  </span>
                )}
                {progress.errorCount > 0 && (
                  <span className="flex items-center gap-1 text-red-400">
                    <AlertCircle className="h-3 w-3" />
                    {progress.errorCount} failed
                  </span>
                )}
              </div>

              {/* Error list */}
              {progress.errors.length > 0 && (
                <div className="max-h-32 overflow-auto rounded border border-red-900/30 bg-red-950/20 p-2">
                  {progress.errors.map((err, i) => (
                    <div
                      key={i}
                      className="text-[10px] text-red-400 leading-relaxed"
                    >
                      {err}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <button
            onClick={handleClose}
            disabled={importing}
            className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-40"
          >
            {progress?.done ? "Close" : "Cancel"}
          </button>
          {mode === "sql" && (
            <button
              onClick={handleImportSql}
              disabled={!fileContent || importing || progress?.done === true}
              className="rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {importing ? "Executing..." : "Execute SQL"}
            </button>
          )}
          {mode === "csv" && (
            <button
              onClick={handleImportCsv}
              disabled={!targetTable
                || csvRows.length === 0
                || Object.values(columnMapping).filter(Boolean).length === 0
                || importing
                || progress?.done === true}
              className="rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {importing ? "Importing..." : "Import CSV"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
