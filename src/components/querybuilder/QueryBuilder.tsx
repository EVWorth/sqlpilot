import { useState, useMemo, useCallback, useRef } from "react";
import {
  Search,
  X,
  Play,
  Copy,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Key,
} from "lucide-react";
import { useSchemaCache } from "../../hooks/useSchemaCache";
import { useEditorStore } from "../../stores/editorStore";
import { api } from "../../lib/tauri-api";
import {
  generateSQL,
  generateAlias,
  getAllColumnRefs,
  getColumnRef,
  WHERE_OPERATORS,
  AGGREGATE_FUNCTIONS,
  CARD_WIDTH,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  type CanvasTable,
  type JoinConfig,
  type JoinType,
  type WhereCondition,
  type WhereOperator,
  type OrderByClause,
  type AggregateFunction,
  type QueryBuilderState,
} from "../../lib/query-builder-engine";
import type { QueryResult, ColumnInfo } from "../../types";

interface QueryBuilderProps {
  connectionId: string;
  database: string;
}

let idCounter = 0;
function uid(): string {
  return `qb-${++idCounter}-${Date.now()}`;
}

const JOIN_COLORS: Record<JoinType, string> = {
  INNER: "#3b82f6",
  LEFT: "#22c55e",
  RIGHT: "#f97316",
};

const JOIN_TYPES: JoinType[] = ["INNER", "LEFT", "RIGHT"];

export function QueryBuilder({ connectionId, database }: QueryBuilderProps) {
  const fetchTables = useSchemaCache((s) => s.fetchTables);
  const fetchColumns = useSchemaCache((s) => s.fetchColumns);
  const cachedTables = useSchemaCache((s) => s.tables);

  const [tableNames, setTableNames] = useState<string[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");

  // Canvas state
  const [canvasTables, setCanvasTables] = useState<CanvasTable[]>([]);
  const [joins, setJoins] = useState<JoinConfig[]>([]);
  const [pendingJoin, setPendingJoin] = useState<{
    tableId: string;
    column: string;
  } | null>(null);

  // Query clauses
  const [whereConditions, setWhereConditions] = useState<WhereCondition[]>([]);
  const [orderByClauses, setOrderByClauses] = useState<OrderByClause[]>([]);
  const [groupByColumns, setGroupByColumns] = useState<string[]>([]);
  const [havingConditions, setHavingConditions] = useState<WhereCondition[]>(
    [],
  );
  const [limit, setLimit] = useState<number | null>(null);

  // Drag state
  const [draggingTableId, setDraggingTableId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Results
  const [results, setResults] = useState<QueryResult[] | null>(null);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bottom panel section
  const [activeSection, setActiveSection] = useState<
    "sql" | "where" | "orderby" | "groupby" | "having"
  >("sql");

  const canvasRef = useRef<HTMLDivElement>(null);

  // Load tables
  if (!tablesLoaded) {
    setTablesLoaded(true);
    const cached = cachedTables.get(database);
    if (cached) {
      setTableNames(cached);
    } else {
      fetchTables(connectionId, database).then(setTableNames);
    }
  }

  const filteredTables = useMemo(
    () =>
      tableNames.filter((t) =>
        t.toLowerCase().includes(searchFilter.toLowerCase()),
      ),
    [tableNames, searchFilter],
  );

  const builderState: QueryBuilderState = useMemo(
    () => ({
      tables: canvasTables,
      joins,
      where: whereConditions,
      orderBy: orderByClauses,
      groupBy: groupByColumns,
      having: havingConditions,
      limit,
    }),
    [
      canvasTables,
      joins,
      whereConditions,
      orderByClauses,
      groupByColumns,
      havingConditions,
      limit,
    ],
  );

  const generatedSQL = useMemo(() => generateSQL(builderState), [builderState]);

  const allColumnRefs = useMemo(
    () => getAllColumnRefs(canvasTables),
    [canvasTables],
  );

  const addTableToCanvas = useCallback(
    async (tableName: string) => {
      const cols = await fetchColumns(connectionId, database, tableName);
      const alias = generateAlias(tableName, canvasTables);
      const existingCount = canvasTables.length;
      const x = 20 + (existingCount % 4) * (CARD_WIDTH + 40);
      const y = 20 + Math.floor(existingCount / 4) * 250;

      const newTable: CanvasTable = {
        id: uid(),
        tableName,
        alias,
        columns: cols,
        selectedColumns: [],
        aggregates: {},
        position: { x, y },
      };
      setCanvasTables((prev) => [...prev, newTable]);
    },
    [connectionId, database, fetchColumns, canvasTables],
  );

  const removeTable = useCallback(
    (tableId: string) => {
      setCanvasTables((prev) => prev.filter((t) => t.id !== tableId));
      setJoins((prev) =>
        prev.filter(
          (j) => j.leftTableId !== tableId && j.rightTableId !== tableId,
        ),
      );
      setPendingJoin(null);
    },
    [],
  );

  const toggleColumn = useCallback((tableId: string, columnName: string) => {
    setCanvasTables((prev) =>
      prev.map((t) => {
        if (t.id !== tableId) return t;
        const selected = t.selectedColumns.includes(columnName)
          ? t.selectedColumns.filter((c) => c !== columnName)
          : [...t.selectedColumns, columnName];
        return { ...t, selectedColumns: selected };
      }),
    );
  }, []);

  const setAggregate = useCallback(
    (tableId: string, columnName: string, agg: AggregateFunction | null) => {
      setCanvasTables((prev) =>
        prev.map((t) => {
          if (t.id !== tableId) return t;
          const aggregates = { ...t.aggregates };
          if (agg) {
            aggregates[columnName] = agg;
          } else {
            delete aggregates[columnName];
          }
          return { ...t, aggregates };
        }),
      );
    },
    [],
  );

  const handleColumnClick = useCallback(
    (tableId: string, column: string) => {
      if (!pendingJoin) {
        setPendingJoin({ tableId, column });
      } else if (pendingJoin.tableId !== tableId) {
        const newJoin: JoinConfig = {
          id: uid(),
          leftTableId: pendingJoin.tableId,
          leftColumn: pendingJoin.column,
          rightTableId: tableId,
          rightColumn: column,
          joinType: "INNER",
        };
        setJoins((prev) => [...prev, newJoin]);
        setPendingJoin(null);
      } else {
        setPendingJoin({ tableId, column });
      }
    },
    [pendingJoin],
  );

  const toggleJoinType = useCallback((joinId: string) => {
    setJoins((prev) =>
      prev.map((j) => {
        if (j.id !== joinId) return j;
        const idx = JOIN_TYPES.indexOf(j.joinType);
        return { ...j, joinType: JOIN_TYPES[(idx + 1) % JOIN_TYPES.length] };
      }),
    );
  }, []);

  const removeJoin = useCallback((joinId: string) => {
    setJoins((prev) => prev.filter((j) => j.id !== joinId));
  }, []);

  // Drag handlers
  const handleTableMouseDown = useCallback(
    (e: React.MouseEvent, tableId: string) => {
      if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
      const table = canvasTables.find((t) => t.id === tableId);
      if (!table || !canvasRef.current) return;
      const canvasRect = canvasRef.current.getBoundingClientRect();
      setDraggingTableId(tableId);
      setDragOffset({
        x: e.clientX - canvasRect.left - table.position.x,
        y: e.clientY - canvasRect.top - table.position.y,
      });
    },
    [canvasTables],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!draggingTableId || !canvasRef.current) return;
      const canvasRect = canvasRef.current.getBoundingClientRect();
      const newX = Math.max(0, e.clientX - canvasRect.left - dragOffset.x);
      const newY = Math.max(0, e.clientY - canvasRect.top - dragOffset.y);
      setCanvasTables((prev) =>
        prev.map((t) =>
          t.id === draggingTableId
            ? { ...t, position: { x: newX, y: newY } }
            : t,
        ),
      );
    },
    [draggingTableId, dragOffset],
  );

  const handleMouseUp = useCallback(() => {
    setDraggingTableId(null);
  }, []);

  // Execute query
  const handleExecute = useCallback(async () => {
    if (!generatedSQL.trim()) return;
    setExecuting(true);
    setError(null);
    try {
      const res = await api.executeQuery(connectionId, generatedSQL);
      setResults(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setExecuting(false);
    }
  }, [connectionId, generatedSQL]);

  // Copy to editor tab
  const handleCopyToEditor = useCallback(() => {
    if (!generatedSQL.trim()) return;
    const tabId = useEditorStore
      .getState()
      .addTab(connectionId, database);
    useEditorStore.getState().updateTabContent(tabId, generatedSQL);
  }, [connectionId, database, generatedSQL]);

  // JOIN line calculations
  const joinLines = useMemo(() => {
    return joins.map((join) => {
      const leftTable = canvasTables.find((t) => t.id === join.leftTableId);
      const rightTable = canvasTables.find((t) => t.id === join.rightTableId);
      if (!leftTable || !rightTable) return null;

      const leftColIdx = leftTable.columns.findIndex(
        (c) => c.name === join.leftColumn,
      );
      const rightColIdx = rightTable.columns.findIndex(
        (c) => c.name === join.rightColumn,
      );

      const leftX = leftTable.position.x + CARD_WIDTH;
      const leftY =
        leftTable.position.y +
        HEADER_HEIGHT +
        leftColIdx * ROW_HEIGHT +
        ROW_HEIGHT / 2;
      const rightX = rightTable.position.x;
      const rightY =
        rightTable.position.y +
        HEADER_HEIGHT +
        rightColIdx * ROW_HEIGHT +
        ROW_HEIGHT / 2;

      const midX = (leftX + rightX) / 2;

      return {
        join,
        path: `M ${leftX} ${leftY} C ${midX} ${leftY}, ${midX} ${rightY}, ${rightX} ${rightY}`,
        labelX: midX,
        labelY: (leftY + rightY) / 2,
        color: JOIN_COLORS[join.joinType],
      };
    });
  }, [joins, canvasTables]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--color-bg-primary)]">
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — table selector */}
        <div className="flex w-52 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <div className="border-b border-[var(--color-border)] p-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input
                type="text"
                placeholder="Filter tables..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="w-full rounded bg-[var(--color-bg-primary)] py-1.5 pl-7 pr-2 text-xs text-[var(--color-text-primary)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-1">
            {filteredTables.map((tableName) => (
              <button
                key={tableName}
                onClick={() => addTableToCanvas(tableName)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
              >
                <Plus className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
                <span className="truncate">{tableName}</span>
              </button>
            ))}
            {filteredTables.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-[var(--color-text-muted)]">
                {tableNames.length === 0
                  ? "Loading tables..."
                  : "No tables found"}
              </p>
            )}
          </div>
        </div>

        {/* Center — canvas + bottom panel */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Canvas */}
          <div
            ref={canvasRef}
            className="relative flex-1 overflow-auto bg-[var(--color-bg-primary)]"
            style={{ minHeight: 300 }}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {canvasTables.length === 0 && (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-[var(--color-text-muted)]">
                  Click a table from the left panel to add it to the canvas
                </p>
              </div>
            )}

            {/* SVG overlay for JOIN lines */}
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              style={{ zIndex: 1 }}
            >
              <defs>
                <marker
                  id="arrowhead"
                  markerWidth="8"
                  markerHeight="6"
                  refX="8"
                  refY="3"
                  orient="auto"
                >
                  <polygon
                    points="0 0, 8 3, 0 6"
                    fill="var(--color-text-muted)"
                  />
                </marker>
              </defs>
              {joinLines.map(
                (line) =>
                  line && (
                    <g key={line.join.id}>
                      <path
                        d={line.path}
                        fill="none"
                        stroke={line.color}
                        strokeWidth={2}
                        markerEnd="url(#arrowhead)"
                      />
                      {/* Clickable invisible wider path */}
                      <path
                        d={line.path}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={12}
                        className="pointer-events-auto cursor-pointer"
                        onClick={() => removeJoin(line.join.id)}
                      />
                      {/* Join type badge */}
                      <foreignObject
                        x={line.labelX - 28}
                        y={line.labelY - 10}
                        width={56}
                        height={20}
                        className="pointer-events-auto"
                      >
                        <button
                          onClick={() => toggleJoinType(line.join.id)}
                          className="flex h-5 w-14 items-center justify-center rounded text-[10px] font-bold"
                          style={{
                            backgroundColor: line.color,
                            color: "#fff",
                          }}
                        >
                          {line.join.joinType}
                        </button>
                      </foreignObject>
                    </g>
                  ),
              )}
            </svg>

            {/* Table cards */}
            {canvasTables.map((table) => (
              <TableCard
                key={table.id}
                table={table}
                pendingJoin={pendingJoin}
                onMouseDown={(e) => handleTableMouseDown(e, table.id)}
                onRemove={() => removeTable(table.id)}
                onToggleColumn={(col) => toggleColumn(table.id, col)}
                onColumnClick={(col) => handleColumnClick(table.id, col)}
                onSetAggregate={(col, agg) =>
                  setAggregate(table.id, col, agg)
                }
              />
            ))}
          </div>

          {/* Bottom panel */}
          <div className="flex shrink-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]" style={{ height: 280 }}>
            {/* Section tabs */}
            <div className="flex items-center border-b border-[var(--color-border)] px-2">
              {(
                [
                  ["sql", "SQL Preview"],
                  ["where", "WHERE"],
                  ["orderby", "ORDER BY"],
                  ["groupby", "GROUP BY"],
                  ["having", "HAVING"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setActiveSection(key)}
                  className={`px-3 py-1.5 text-xs transition-colors ${
                    activeSection === key
                      ? "border-b-2 border-brand-500 text-[var(--color-text-primary)]"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  }`}
                >
                  {label}
                </button>
              ))}
              <div className="flex-1" />
              {/* LIMIT input */}
              <div className="flex items-center gap-1 mr-2">
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  LIMIT
                </span>
                <input
                  type="number"
                  min={0}
                  value={limit ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setLimit(v === "" ? null : parseInt(v, 10));
                  }}
                  placeholder="—"
                  className="w-16 rounded bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-xs text-[var(--color-text-primary)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
                />
              </div>
              <button
                onClick={handleCopyToEditor}
                disabled={!generatedSQL}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40"
                title="Copy to Editor"
              >
                <Copy className="h-3.5 w-3.5" />
                <span>Copy to Editor</span>
              </button>
              <button
                onClick={handleExecute}
                disabled={!generatedSQL || executing}
                className="ml-1 flex items-center gap-1 rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-500 transition-colors disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{executing ? "Running..." : "Execute"}</span>
              </button>
            </div>

            {/* Section content */}
            <div className="flex-1 overflow-auto p-2">
              {activeSection === "sql" && (
                <SqlPreviewSection
                  sql={generatedSQL}
                  results={results}
                  error={error}
                />
              )}
              {activeSection === "where" && (
                <WhereSection
                  conditions={whereConditions}
                  columnRefs={allColumnRefs}
                  onChange={setWhereConditions}
                />
              )}
              {activeSection === "orderby" && (
                <OrderBySection
                  clauses={orderByClauses}
                  columnRefs={allColumnRefs}
                  onChange={setOrderByClauses}
                />
              )}
              {activeSection === "groupby" && (
                <GroupBySection
                  columns={groupByColumns}
                  columnRefs={allColumnRefs}
                  onChange={setGroupByColumns}
                />
              )}
              {activeSection === "having" && (
                <WhereSection
                  conditions={havingConditions}
                  columnRefs={allColumnRefs}
                  onChange={setHavingConditions}
                  isHaving
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Table Card ────────────────────────────────────────────── */

interface TableCardProps {
  table: CanvasTable;
  pendingJoin: { tableId: string; column: string } | null;
  onMouseDown: (e: React.MouseEvent) => void;
  onRemove: () => void;
  onToggleColumn: (column: string) => void;
  onColumnClick: (column: string) => void;
  onSetAggregate: (column: string, agg: AggregateFunction | null) => void;
}

function TableCard({
  table,
  pendingJoin,
  onMouseDown,
  onRemove,
  onToggleColumn,
  onColumnClick,
  onSetAggregate,
}: TableCardProps) {
  const isPendingSource =
    pendingJoin !== null && pendingJoin.tableId === table.id;
  const isPendingTarget =
    pendingJoin !== null && pendingJoin.tableId !== table.id;

  return (
    <div
      onMouseDown={onMouseDown}
      className="absolute select-none rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg"
      style={{
        left: table.position.x,
        top: table.position.y,
        width: CARD_WIDTH,
        zIndex: 2,
        cursor: "grab",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between rounded-t px-2"
        style={{ height: HEADER_HEIGHT }}
      >
        <span className="truncate text-xs font-bold text-[var(--color-text-primary)]">
          {table.alias !== table.tableName
            ? `${table.tableName} (${table.alias})`
            : table.tableName}
        </span>
        <button
          data-no-drag
          onClick={onRemove}
          className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-red-400 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Columns */}
      <div className="border-t border-[var(--color-border)]">
        {table.columns.map((col) => {
          const isSelected = table.selectedColumns.includes(col.name);
          const isPendingCol =
            isPendingSource && pendingJoin?.column === col.name;
          const aggregate = table.aggregates[col.name];

          return (
            <div
              key={col.name}
              className={`flex items-center gap-1 px-2 text-[11px] transition-colors ${
                isPendingCol
                  ? "bg-brand-600/20"
                  : isPendingTarget
                    ? "hover:bg-brand-600/10 cursor-crosshair"
                    : "hover:bg-[var(--color-bg-tertiary)]"
              }`}
              style={{ height: ROW_HEIGHT }}
            >
              <input
                data-no-drag
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggleColumn(col.name)}
                className="h-3 w-3 shrink-0 accent-brand-500"
              />
              <button
                data-no-drag
                onClick={() => onColumnClick(col.name)}
                className="flex flex-1 items-center gap-1 truncate text-left"
                title={`${col.name} (${col.column_type})${col.is_primary_key ? " PK" : ""}${col.nullable ? " NULL" : ""} — click to join`}
              >
                {col.is_primary_key && (
                  <Key className="h-2.5 w-2.5 shrink-0 text-yellow-500" />
                )}
                <span
                  className={`truncate ${isSelected ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}`}
                >
                  {col.name}
                </span>
                <span className="ml-auto shrink-0 text-[9px] text-[var(--color-text-muted)]">
                  {col.data_type}
                </span>
              </button>
              {isSelected && (
                <select
                  data-no-drag
                  value={aggregate ?? ""}
                  onChange={(e) =>
                    onSetAggregate(
                      col.name,
                      e.target.value
                        ? (e.target.value as AggregateFunction)
                        : null,
                    )
                  }
                  className="h-5 w-14 shrink-0 rounded bg-[var(--color-bg-primary)] text-[9px] text-[var(--color-text-muted)] outline-none"
                  title="Aggregate function"
                >
                  <option value="">—</option>
                  {AGGREGATE_FUNCTIONS.map((fn) => (
                    <option key={fn} value={fn}>
                      {fn}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── SQL Preview Section ───────────────────────────────────── */

function SqlPreviewSection({
  sql,
  results,
  error,
}: {
  sql: string;
  results: QueryResult[] | null;
  error: string | null;
}) {
  return (
    <div className="flex h-full flex-col gap-2">
      <pre className="flex-1 overflow-auto rounded bg-[var(--color-bg-primary)] p-2 text-xs text-[var(--color-text-primary)] ring-1 ring-[var(--color-border)]">
        {sql || "-- Build your query by adding tables and selecting columns"}
      </pre>
      {error && (
        <div className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400">
          {error}
        </div>
      )}
      {results && results.length > 0 && (
        <div className="overflow-auto rounded ring-1 ring-[var(--color-border)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[var(--color-bg-tertiary)]">
                {results[0].columns.map((col) => (
                  <th
                    key={col.name}
                    className="px-2 py-1 text-left font-medium text-[var(--color-text-secondary)]"
                  >
                    {col.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results[0].rows.slice(0, 50).map((row, i) => (
                <tr
                  key={i}
                  className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="px-2 py-1 text-[var(--color-text-primary)]"
                    >
                      {cell === null ? (
                        <span className="text-[var(--color-text-muted)]">
                          NULL
                        </span>
                      ) : (
                        String(cell)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {results[0].rows.length > 50 && (
            <p className="px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
              Showing 50 of {results[0].rows.length} rows
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── WHERE / HAVING Section ────────────────────────────────── */

function WhereSection({
  conditions,
  columnRefs,
  onChange,
  isHaving,
}: {
  conditions: WhereCondition[];
  columnRefs: { ref: string; label: string }[];
  onChange: (conditions: WhereCondition[]) => void;
  isHaving?: boolean;
}) {
  const addCondition = () => {
    onChange([
      ...conditions,
      {
        id: uid(),
        column: columnRefs[0]?.ref ?? "",
        operator: "=",
        value: "",
        logic: "AND",
      },
    ]);
  };

  const updateCondition = (id: string, updates: Partial<WhereCondition>) => {
    onChange(
      conditions.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    );
  };

  const removeCondition = (id: string) => {
    onChange(conditions.filter((c) => c.id !== id));
  };

  const needsValue = (op: WhereOperator) =>
    op !== "IS NULL" && op !== "IS NOT NULL";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-[var(--color-text-secondary)]">
          {isHaving ? "HAVING" : "WHERE"} Conditions
        </span>
        <button
          onClick={addCondition}
          disabled={columnRefs.length === 0}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-brand-400 hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-40"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>
      {conditions.map((cond, idx) => (
        <div key={cond.id} className="flex items-center gap-1">
          {idx > 0 ? (
            <button
              onClick={() =>
                updateCondition(cond.id, {
                  logic: cond.logic === "AND" ? "OR" : "AND",
                })
              }
              className="w-10 shrink-0 rounded bg-[var(--color-bg-primary)] px-1 py-0.5 text-center text-[10px] font-bold text-brand-400 ring-1 ring-[var(--color-border)]"
            >
              {cond.logic}
            </button>
          ) : (
            <span className="w-10 shrink-0" />
          )}
          <select
            value={cond.column}
            onChange={(e) =>
              updateCondition(cond.id, { column: e.target.value })
            }
            className="h-6 w-40 shrink-0 rounded bg-[var(--color-bg-primary)] px-1 text-xs text-[var(--color-text-primary)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
          >
            {columnRefs.map((cr) => (
              <option key={cr.ref} value={cr.ref}>
                {cr.label}
              </option>
            ))}
          </select>
          <select
            value={cond.operator}
            onChange={(e) =>
              updateCondition(cond.id, {
                operator: e.target.value as WhereOperator,
              })
            }
            className="h-6 w-24 shrink-0 rounded bg-[var(--color-bg-primary)] px-1 text-xs text-[var(--color-text-primary)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
          >
            {WHERE_OPERATORS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          {needsValue(cond.operator) && (
            <input
              type="text"
              value={cond.value}
              onChange={(e) =>
                updateCondition(cond.id, { value: e.target.value })
              }
              placeholder="value"
              className="h-6 flex-1 rounded bg-[var(--color-bg-primary)] px-1.5 text-xs text-[var(--color-text-primary)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
            />
          )}
          <button
            onClick={() => removeCondition(cond.id)}
            className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:text-red-400 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {conditions.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          No conditions. Click &quot;Add&quot; to create one.
        </p>
      )}
    </div>
  );
}

/* ─── ORDER BY Section ──────────────────────────────────────── */

function OrderBySection({
  clauses,
  columnRefs,
  onChange,
}: {
  clauses: OrderByClause[];
  columnRefs: { ref: string; label: string }[];
  onChange: (clauses: OrderByClause[]) => void;
}) {
  const addClause = () => {
    onChange([
      ...clauses,
      { id: uid(), column: columnRefs[0]?.ref ?? "", direction: "ASC" },
    ]);
  };

  const updateClause = (id: string, updates: Partial<OrderByClause>) => {
    onChange(clauses.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  };

  const removeClause = (id: string) => {
    onChange(clauses.filter((c) => c.id !== id));
  };

  const moveClause = (idx: number, dir: -1 | 1) => {
    const newClauses = [...clauses];
    const target = idx + dir;
    if (target < 0 || target >= newClauses.length) return;
    [newClauses[idx], newClauses[target]] = [
      newClauses[target],
      newClauses[idx],
    ];
    onChange(newClauses);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-[var(--color-text-secondary)]">
          ORDER BY
        </span>
        <button
          onClick={addClause}
          disabled={columnRefs.length === 0}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-brand-400 hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-40"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>
      {clauses.map((clause, idx) => (
        <div key={clause.id} className="flex items-center gap-1">
          <select
            value={clause.column}
            onChange={(e) =>
              updateClause(clause.id, { column: e.target.value })
            }
            className="h-6 w-48 shrink-0 rounded bg-[var(--color-bg-primary)] px-1 text-xs text-[var(--color-text-primary)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
          >
            {columnRefs.map((cr) => (
              <option key={cr.ref} value={cr.ref}>
                {cr.label}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              updateClause(clause.id, {
                direction: clause.direction === "ASC" ? "DESC" : "ASC",
              })
            }
            className="flex h-6 items-center gap-0.5 rounded bg-[var(--color-bg-primary)] px-1.5 text-[10px] font-bold text-brand-400 ring-1 ring-[var(--color-border)]"
          >
            {clause.direction === "ASC" ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            {clause.direction}
          </button>
          <button
            onClick={() => moveClause(idx, -1)}
            disabled={idx === 0}
            className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-20"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => moveClause(idx, 1)}
            disabled={idx === clauses.length - 1}
            className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-20"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => removeClause(clause.id)}
            className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:text-red-400 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {clauses.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          No ordering. Click &quot;Add&quot; to create one.
        </p>
      )}
    </div>
  );
}

/* ─── GROUP BY Section ──────────────────────────────────────── */

function GroupBySection({
  columns,
  columnRefs,
  onChange,
}: {
  columns: string[];
  columnRefs: { ref: string; label: string }[];
  onChange: (columns: string[]) => void;
}) {
  const addColumn = () => {
    const first = columnRefs[0]?.ref;
    if (first) onChange([...columns, first]);
  };

  const updateColumn = (idx: number, value: string) => {
    const newCols = [...columns];
    newCols[idx] = value;
    onChange(newCols);
  };

  const removeColumn = (idx: number) => {
    onChange(columns.filter((_, i) => i !== idx));
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-[var(--color-text-secondary)]">
          GROUP BY
        </span>
        <button
          onClick={addColumn}
          disabled={columnRefs.length === 0}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-brand-400 hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-40"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>
      {columns.map((col, idx) => (
        <div key={idx} className="flex items-center gap-1">
          <select
            value={col}
            onChange={(e) => updateColumn(idx, e.target.value)}
            className="h-6 w-48 shrink-0 rounded bg-[var(--color-bg-primary)] px-1 text-xs text-[var(--color-text-primary)] outline-none ring-1 ring-[var(--color-border)] focus:ring-brand-500"
          >
            {columnRefs.map((cr) => (
              <option key={cr.ref} value={cr.ref}>
                {cr.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => removeColumn(idx)}
            className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:text-red-400 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {columns.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          No grouping. Click &quot;Add&quot; to create one.
        </p>
      )}
    </div>
  );
}
