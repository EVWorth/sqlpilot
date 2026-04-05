import { useState, useEffect, useCallback, useMemo } from "react";
import Editor from "@monaco-editor/react";
import {
  Play,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  Clock,
  Rows3,
  Cog,
  FunctionSquare,
} from "lucide-react";
import { api } from "../../lib/tauri-api";
import {
  parseRoutineMetadata,
  type RoutineParameter,
} from "../../lib/routine-parser";
import { useEditorStore } from "../../stores/editorStore";
import { cn } from "../../lib/utils";
import type { QueryResult } from "../../types";

interface RoutineViewerProps {
  connectionId: string;
  database: string;
  routineName: string;
  routineType: "PROCEDURE" | "FUNCTION";
}

export function RoutineViewer({
  connectionId,
  database,
  routineName,
  routineType,
}: RoutineViewerProps) {
  const [ddl, setDdl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDdl, setShowDdl] = useState(true);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [executing, setExecuting] = useState(false);
  const [results, setResults] = useState<QueryResult[] | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [execTime, setExecTime] = useState<number | null>(null);
  const [outParamResults, setOutParamResults] = useState<
    Record<string, string>
  >({});

  const loadDdl = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const text = await api.getRoutineDdl(
        connectionId,
        database,
        routineName,
        routineType,
      );
      setDdl(text);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId, database, routineName, routineType]);

  useEffect(() => {
    loadDdl();
  }, [loadDdl]);

  const metadata = useMemo(() => parseRoutineMetadata(ddl), [ddl]);
  const params = metadata.parameters;

  const inParams = useMemo(
    () => params.filter((p) => p.direction === "IN" || p.direction === "INOUT"),
    [params],
  );
  const outParams = useMemo(
    () =>
      params.filter((p) => p.direction === "OUT" || p.direction === "INOUT"),
    [params],
  );

  const handleParamChange = (name: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleExecute = async () => {
    setExecuting(true);
    setExecError(null);
    setResults(null);
    setOutParamResults({});

    const startTime = performance.now();

    try {
      if (routineType === "PROCEDURE") {
        await executeProcedure();
      } else {
        await executeFunction();
      }
      setExecTime(Math.round(performance.now() - startTime));
    } catch (e) {
      setExecError(String(e));
      setExecTime(Math.round(performance.now() - startTime));
    } finally {
      setExecuting(false);
    }
  };

  const executeProcedure = async () => {
    const statements: string[] = [];

    // Set IN/INOUT params as session variables
    for (const p of params) {
      if (p.direction === "IN" || p.direction === "INOUT") {
        const val = paramValues[p.name];
        if (val !== undefined && val !== "") {
          statements.push(
            `SET @${p.name} = ${formatParamValue(val, p.dataType)}`,
          );
        } else {
          statements.push(`SET @${p.name} = NULL`);
        }
      } else {
        // OUT params: initialize to NULL
        statements.push(`SET @${p.name} = NULL`);
      }
    }

    // Build CALL statement with session variable references
    const callArgs = params.map((p) => `@${p.name}`).join(", ");
    statements.push(`CALL \`${database}\`.\`${routineName}\`(${callArgs})`);

    // Read OUT/INOUT params
    if (outParams.length > 0) {
      const selectParts = outParams.map((p) => `@${p.name} AS \`${p.name}\``);
      statements.push(`SELECT ${selectParts.join(", ")}`);
    }

    const sql = statements.join(";\n") + ";";
    const queryResults = await api.executeQuery(connectionId, sql);
    setResults(queryResults);

    // Extract OUT param values from the last result set
    if (outParams.length > 0 && queryResults.length > 0) {
      const lastResult = queryResults[queryResults.length - 1];
      if (lastResult.rows.length > 0) {
        const outVals: Record<string, string> = {};
        lastResult.columns.forEach((col, idx) => {
          const val = lastResult.rows[0][idx];
          outVals[col.name] = val === null ? "NULL" : String(val);
        });
        setOutParamResults(outVals);
      }
    }
  };

  const executeFunction = async () => {
    const args = inParams
      .map((p) => {
        const val = paramValues[p.name];
        if (val !== undefined && val !== "") {
          return formatParamValue(val, p.dataType);
        }
        return "NULL";
      })
      .join(", ");

    const sql = `SELECT \`${database}\`.\`${routineName}\`(${args}) AS \`result\``;
    const queryResults = await api.executeQuery(connectionId, sql);
    setResults(queryResults);
  };

  const handleEditDdl = () => {
    const tabId = useEditorStore.getState().addTab(connectionId, database);
    useEditorStore.getState().updateTabContent(tabId, ddl);
  };

  const handleDrop = () => {
    if (
      !window.confirm(
        `Are you sure you want to drop ${routineType.toLowerCase()} \`${database}\`.\`${routineName}\`?`,
      )
    )
      return;
    api
      .executeQuery(
        connectionId,
        `DROP ${routineType} \`${database}\`.\`${routineName}\``,
      )
      .then(() => {
        const tabId = useEditorStore
          .getState()
          .tabs.find(
            (t) =>
              t.type === "routine" &&
              t.routineName === routineName &&
              t.database === database,
          )?.id;
        if (tabId) useEditorStore.getState().closeTab(tabId);
      })
      .catch((e) => setExecError(String(e)));
  };

  const isProcedure = routineType === "PROCEDURE";
  const typeIcon = isProcedure ? (
    <Cog className="h-4 w-4" />
  ) : (
    <FunctionSquare className="h-4 w-4" />
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg-primary)]">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--color-text-muted)]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-[var(--color-bg-primary)]">
        <AlertCircle className="h-6 w-6 text-red-400" />
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={loadDdl}
          className="rounded bg-[var(--color-bg-tertiary)] px-3 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--color-bg-primary)]">
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--color-text-primary)]">
          {typeIcon}
          <span className="uppercase text-[10px] font-semibold text-[var(--color-text-muted)]">
            {routineType}
          </span>
          <code className="text-sm text-brand-400">{routineName}</code>
        </span>

        {metadata.returnsType && (
          <span className="ml-2 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
            → {metadata.returnsType}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={handleExecute}
            disabled={executing}
            className="flex items-center gap-1 rounded bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-50"
          >
            {executing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            Execute
          </button>
          <button
            onClick={handleEditDdl}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
            title="Edit DDL in query tab"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
          <button
            onClick={handleDrop}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
            title={`Drop ${routineType.toLowerCase()}`}
          >
            <Trash2 className="h-3 w-3" />
          </button>
          <button
            onClick={loadDdl}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
            title="Refresh DDL"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* DDL Section */}
        <div className="border-b border-[var(--color-border)]">
          <button
            onClick={() => setShowDdl(!showDdl)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
          >
            {showDdl ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            DDL Definition
            {metadata.isDeterministic !== undefined && (
              <span className="ml-2 rounded bg-[var(--color-bg-tertiary)] px-1 py-0.5 text-[9px] text-[var(--color-text-muted)]">
                {metadata.isDeterministic ? "DETERMINISTIC" : "NOT DETERMINISTIC"}
              </span>
            )}
            {metadata.sqlSecurity && (
              <span className="rounded bg-[var(--color-bg-tertiary)] px-1 py-0.5 text-[9px] text-[var(--color-text-muted)]">
                {metadata.sqlSecurity}
              </span>
            )}
          </button>
          {showDdl && (
            <div className="h-[250px] border-t border-[var(--color-border)]">
              <Editor
                value={ddl}
                language="sql"
                theme="vs-dark"
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                  wordWrap: "on",
                  folding: true,
                  renderLineHighlight: "none",
                  overviewRulerLanes: 0,
                  hideCursorInOverviewRuler: true,
                  scrollbar: {
                    verticalScrollbarSize: 8,
                    horizontalScrollbarSize: 8,
                  },
                }}
              />
            </div>
          )}
        </div>

        {/* Parameters Section */}
        {params.length > 0 && (
          <div className="border-b border-[var(--color-border)] px-3 py-2">
            <h3 className="mb-2 text-xs font-medium text-[var(--color-text-secondary)]">
              Parameters
            </h3>
            <div className="space-y-1.5">
              {params.map((p) => (
                <ParameterRow
                  key={p.name}
                  param={p}
                  value={paramValues[p.name] ?? ""}
                  outValue={outParamResults[p.name]}
                  onChange={(v) => handleParamChange(p.name, v)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Metadata badges */}
        {metadata.comment && (
          <div className="border-b border-[var(--color-border)] px-3 py-2">
            <p className="text-xs italic text-[var(--color-text-muted)]">
              {metadata.comment}
            </p>
          </div>
        )}

        {/* Execution error */}
        {execError && (
          <div className="mx-3 mt-2 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
            <pre className="flex-1 whitespace-pre-wrap text-xs text-red-400">
              {execError}
            </pre>
          </div>
        )}

        {/* Results Section */}
        {results && results.length > 0 && (
          <div className="px-3 py-2">
            <div className="mb-2 flex items-center gap-3">
              <h3 className="text-xs font-medium text-[var(--color-text-secondary)]">
                Results
              </h3>
              {execTime !== null && (
                <span className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                  <Clock className="h-3 w-3" />
                  {execTime}ms
                </span>
              )}
            </div>
            {results.map((result, idx) => (
              <ResultTable key={idx} result={result} index={idx} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ParameterRow({
  param,
  value,
  outValue,
  onChange,
}: {
  param: RoutineParameter;
  value: string;
  outValue?: string;
  onChange: (v: string) => void;
}) {
  const isReadOnly = param.direction === "OUT";
  const displayValue = isReadOnly && outValue !== undefined ? outValue : value;

  const directionColor = {
    IN: "text-blue-400 bg-blue-500/10 border-blue-500/30",
    OUT: "text-amber-400 bg-amber-500/10 border-amber-500/30",
    INOUT: "text-purple-400 bg-purple-500/10 border-purple-500/30",
  }[param.direction];

  const inputType = getInputType(param.dataType);

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "w-12 shrink-0 rounded border px-1.5 py-0.5 text-center text-[9px] font-bold",
          directionColor,
        )}
      >
        {param.direction}
      </span>
      <span className="w-28 shrink-0 truncate text-xs font-medium text-[var(--color-text-primary)]">
        {param.name}
      </span>
      <span className="w-32 shrink-0 truncate text-[10px] text-[var(--color-text-muted)]">
        {param.dataType}
      </span>
      <input
        type={inputType}
        value={displayValue}
        onChange={(e) => onChange(e.target.value)}
        readOnly={isReadOnly}
        placeholder={isReadOnly ? "(output)" : `Enter ${param.name}...`}
        className={cn(
          "flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-brand-500 focus:outline-none",
          isReadOnly && "cursor-default opacity-70",
          outValue !== undefined &&
            isReadOnly &&
            "border-amber-500/30 bg-amber-500/5 text-amber-300",
        )}
      />
    </div>
  );
}

function ResultTable({
  result,
  index,
}: {
  result: QueryResult;
  index: number;
}) {
  if (result.columns.length === 0) {
    return (
      <div className="mb-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <Rows3 className="h-3 w-3" />
          Statement {index + 1}: {result.rows_affected} row(s) affected
          <span className="ml-auto text-[10px]">
            {result.execution_time_ms}ms
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-2 overflow-hidden rounded border border-[var(--color-border)]">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-[var(--color-bg-tertiary)]">
              {result.columns.map((col) => (
                <th
                  key={col.name}
                  className="whitespace-nowrap border-b border-r border-[var(--color-border)] px-2 py-1 text-left font-medium text-[var(--color-text-secondary)]"
                >
                  {col.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className="hover:bg-[var(--color-bg-secondary)]"
              >
                {row.map((cell, colIdx) => (
                  <td
                    key={colIdx}
                    className={cn(
                      "whitespace-nowrap border-b border-r border-[var(--color-border)] px-2 py-1",
                      cell === null
                        ? "italic text-[var(--color-text-muted)]"
                        : "text-[var(--color-text-primary)]",
                    )}
                  >
                    {cell === null ? "NULL" : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 bg-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
        <Rows3 className="h-3 w-3" />
        {result.rows.length} row(s)
        <span className="ml-auto">{result.execution_time_ms}ms</span>
      </div>
    </div>
  );
}

function getInputType(dataType: string): string {
  const upper = dataType.toUpperCase();
  if (
    /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\b/.test(upper)
  ) {
    return "number";
  }
  if (/^(FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL)\b/.test(upper)) {
    return "number";
  }
  if (/^DATE$/.test(upper)) {
    return "date";
  }
  if (/^(DATETIME|TIMESTAMP)\b/.test(upper)) {
    return "datetime-local";
  }
  if (/^TIME\b/.test(upper)) {
    return "time";
  }
  return "text";
}

function formatParamValue(value: string, dataType: string): string {
  const upper = dataType.toUpperCase();
  if (
    /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|BIT|BOOLEAN|BOOL)\b/.test(
      upper,
    )
  ) {
    const num = Number(value);
    if (!isNaN(num)) return String(num);
  }
  // Escape single quotes in string values
  const escaped = value.replace(/'/g, "\\'");
  return `'${escaped}'`;
}
