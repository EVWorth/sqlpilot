import { GitBranch, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useResultStore } from "../../stores/resultStore";
import type { QueryResult, SqlValue } from "../../types";

type ViewMode = "table" | "tree";

const TYPE_RANK: Record<string, number> = {
  ALL: 0,
  index: 1,
  range: 2,
  ref: 3,
  eq_ref: 4,
  const: 5,
  system: 6,
  NULL: 7,
};

const TYPE_COLORS: Record<string, string> = {
  ALL: "bg-red-600/80 text-white",
  index: "bg-yellow-600/80 text-white",
  range: "bg-yellow-500/70 text-white",
  ref: "bg-green-600/80 text-white",
  eq_ref: "bg-green-500/80 text-white",
  const: "bg-blue-500/80 text-white",
  system: "bg-blue-500/80 text-white",
  NULL: "bg-blue-400/80 text-white",
};

function getTypeColor(type: string): string {
  return TYPE_COLORS[type] ?? "bg-gray-600/80 text-white";
}

interface ExplainRow {
  id: SqlValue;
  select_type: string;
  table: string;
  partitions: string;
  type: string;
  possible_keys: string;
  key: string;
  key_len: string;
  ref: string;
  rows: number;
  filtered: number;
  Extra: string;
}

function parseExplainRows(result: QueryResult): ExplainRow[] {
  const colNames = result.columns.map((c) => c.name.toLowerCase());
  return result.rows.map((row) => {
    const get = (name: string): string => {
      const idx = colNames.indexOf(name.toLowerCase());
      if (idx === -1) return "";
      const val = row[idx];
      return val === null ? "" : String(val);
    };
    const getNum = (name: string): number => {
      const v = get(name);
      return v ? Number(v) : 0;
    };
    return {
      id: row[colNames.indexOf("id")] ?? null,
      select_type: get("select_type"),
      table: get("table"),
      partitions: get("partitions"),
      type: get("type"),
      possible_keys: get("possible_keys"),
      key: get("key"),
      key_len: get("key_len"),
      ref: get("ref"),
      rows: getNum("rows"),
      filtered: getNum("filtered"),
      Extra: get("extra"),
    };
  });
}

function ExtraHighlight({ text }: { text: string }) {
  if (!text) return <span className="text-[var(--color-text-muted)]">—</span>;
  const parts = text.split(/(Using filesort|Using temporary|Using index|Using where|Using join buffer)/g);
  return (
    <span>
      {parts.map((part, i) => {
        if (part === "Using filesort") {
          return (
            <span key={i} className="rounded px-1 bg-orange-600/30 text-orange-300">
              {part}
            </span>
          );
        }
        if (part === "Using temporary") {
          return (
            <span key={i} className="rounded px-1 bg-red-600/30 text-red-300">
              {part}
            </span>
          );
        }
        if (part === "Using index") {
          return (
            <span key={i} className="rounded px-1 bg-green-600/30 text-green-300">
              {part}
            </span>
          );
        }
        if (part === "Using where") {
          return (
            <span key={i} className="rounded px-1 bg-blue-600/30 text-blue-300">
              {part}
            </span>
          );
        }
        if (part === "Using join buffer") {
          return (
            <span key={i} className="rounded px-1 bg-yellow-600/30 text-yellow-300">
              {part}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

function KeyHighlight({
  possibleKeys,
  usedKey,
  field,
}: {
  possibleKeys: string;
  usedKey: string;
  field: "possible" | "used";
}) {
  const text = field === "possible" ? possibleKeys : usedKey;
  if (!text) return <span className="text-[var(--color-text-muted)]">—</span>;

  if (field === "possible") {
    const keys = text.split(",");
    return (
      <span>
        {keys.map((k, i) => (
          <span key={i}>
            {i > 0 && ", "}
            <span
              className={k.trim() === usedKey
                ? "rounded bg-green-600/30 px-1 text-green-300"
                : ""}
            >
              {k.trim()}
            </span>
          </span>
        ))}
      </span>
    );
  }
  return <span className="font-medium text-green-400">{text}</span>;
}

function RowsBar({ rows, maxRows }: { rows: number; maxRows: number }) {
  const pct = maxRows > 0 ? Math.max(2, (rows / maxRows) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-right tabular-nums">{rows.toLocaleString()}</span>
      <div className="h-3 flex-1 rounded-sm bg-[var(--color-bg-tertiary)]">
        <div
          className="h-full rounded-sm bg-brand-500/70 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ExplainTable({ result }: { result: QueryResult }) {
  const rows = useMemo(() => parseExplainRows(result), [result]);
  const maxRows = useMemo(
    () => Math.max(...rows.map((r) => r.rows), 1),
    [rows],
  );

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10">
          <tr>
            {[
              "id",
              "select_type",
              "table",
              "type",
              "possible_keys",
              "key",
              "key_len",
              "ref",
              "rows",
              "filtered",
              "Extra",
            ].map(
              (col) => (
                <th
                  key={col}
                  className="border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-left font-medium text-[var(--color-text-secondary)]"
                >
                  {col}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={idx} className="hover:bg-[var(--color-bg-secondary)]">
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-primary)]">
                {row.id === null ? "NULL" : String(row.id)}
              </td>
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-primary)]">
                {row.select_type}
              </td>
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 font-medium text-[var(--color-text-primary)]">
                {row.table || <span className="text-[var(--color-text-muted)]">—</span>}
              </td>
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5">
                {row.type
                  ? (
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        getTypeColor(row.type)
                      }`}
                    >
                      {row.type}
                    </span>
                  )
                  : <span className="text-[var(--color-text-muted)]">—</span>}
              </td>
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-primary)]">
                <KeyHighlight possibleKeys={row.possible_keys} usedKey={row.key} field="possible" />
              </td>
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-primary)]">
                <KeyHighlight possibleKeys={row.possible_keys} usedKey={row.key} field="used" />
              </td>
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-muted)]">
                {row.key_len || "—"}
              </td>
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-muted)]">
                {row.ref || "—"}
              </td>
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-primary)] min-w-[180px]">
                <RowsBar rows={row.rows} maxRows={maxRows} />
              </td>
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-muted)]">
                {row.filtered ? `${row.filtered}%` : "—"}
              </td>
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-primary)]">
                <ExtraHighlight text={row.Extra} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface TreeNode {
  table: string;
  type: string;
  rows: number;
  filtered: number;
  key: string;
  selectType: string;
  extra: string;
  children: TreeNode[];
}

function buildTree(result: QueryResult): TreeNode[] {
  const rows = parseExplainRows(result);
  const nodes: TreeNode[] = rows.map((r) => ({
    table: r.table,
    type: r.type,
    rows: r.rows,
    filtered: r.filtered,
    key: r.key,
    selectType: r.select_type,
    extra: r.Extra,
    children: [],
  }));

  // Group by id — subqueries nest under their parent
  if (nodes.length <= 1) return nodes;

  const explainRows = parseExplainRows(result);
  const ids = explainRows.map((r) => (r.id === null ? 0 : Number(r.id)));
  const root: TreeNode[] = [];
  const idGroups = new Map<number, TreeNode[]>();

  ids.forEach((id, i) => {
    if (!idGroups.has(id)) idGroups.set(id, []);
    idGroups.get(id)!.push(nodes[i]);
  });

  const sortedIds = [...new Set(ids)].sort((a, b) => a - b);
  if (sortedIds.length === 1) return nodes;

  // First id group becomes root; subsequent groups are children of the last node in prior group
  sortedIds.forEach((id, gi) => {
    const group = idGroups.get(id)!;
    if (gi === 0) {
      root.push(...group);
    } else {
      const parent = root[root.length - 1];
      parent.children.push(...group);
    }
  });

  return root;
}

function TreeNodeView({
  node,
  maxRows,
  isLast,
  depth,
}: {
  node: TreeNode;
  maxRows: number;
  isLast: boolean;
  depth: number;
}) {
  const costWidth = maxRows > 0 ? Math.max(40, (node.rows / maxRows) * 200) : 40;

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-0">
        {depth > 0 && (
          <div className="flex flex-col items-center mr-1" style={{ width: 20 }}>
            <div
              className={`w-px bg-[var(--color-border)] ${isLast ? "h-3" : "h-full"}`}
              style={{ minHeight: 12 }}
            />
            <div className="w-3 h-px bg-[var(--color-border)]" />
          </div>
        )}
        <div
          className="flex flex-col gap-0.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 my-0.5"
          style={{ minWidth: costWidth + 80 }}
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-[var(--color-text-primary)]">
              {node.table || node.selectType}
            </span>
            {node.type && (
              <span
                className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${getTypeColor(node.type)}`}
              >
                {node.type}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-[10px] text-[var(--color-text-muted)]">
            <span>
              rows: <span className="text-[var(--color-text-secondary)]">{node.rows.toLocaleString()}</span>
            </span>
            {node.filtered > 0 && (
              <span>
                filtered: <span className="text-[var(--color-text-secondary)]">{node.filtered}%</span>
              </span>
            )}
            {node.key && (
              <span>
                key: <span className="text-green-400">{node.key}</span>
              </span>
            )}
          </div>
          {node.extra && (
            <div className="text-[10px]">
              <ExtraHighlight text={node.extra} />
            </div>
          )}
        </div>
      </div>
      {node.children.length > 0 && (
        <div className="ml-5 flex flex-col border-l border-[var(--color-border)]">
          {node.children.map((child, i) => (
            <TreeNodeView
              key={i}
              node={child}
              maxRows={maxRows}
              isLast={i === node.children.length - 1}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ExplainTreeView({ result }: { result: QueryResult }) {
  const tree = useMemo(() => buildTree(result), [result]);
  const maxRows = useMemo(() => {
    const rows = parseExplainRows(result);
    return Math.max(...rows.map((r) => r.rows), 1);
  }, [result]);

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="flex flex-col gap-0">
        {tree.map((node, i) => (
          <TreeNodeView
            key={i}
            node={node}
            maxRows={maxRows}
            isLast={i === tree.length - 1}
            depth={0}
          />
        ))}
      </div>
    </div>
  );
}

function AnalyzeView({ result }: { result: QueryResult }) {
  const text = useMemo(() => {
    if (!result.rows.length) return "";
    return result.rows.map((row) => row.map((v) => String(v ?? "")).join("\n")).join("\n");
  }, [result]);

  // Highlight cost and timing values in the EXPLAIN ANALYZE text
  const highlighted = useMemo(() => {
    return text.split("\n").map((line, i) => {
      const parts = line.split(
        /(actual time=[\d.]+\.\.[\d.]+|rows=\d+|loops=\d+|cost=[\d.]+)/g,
      );
      return (
        <div key={i} className="whitespace-pre">
          {parts.map((part, j) => {
            if (part.startsWith("actual time=")) {
              return (
                <span key={j} className="text-yellow-300">
                  {part}
                </span>
              );
            }
            if (part.startsWith("rows=")) {
              return (
                <span key={j} className="text-blue-300">
                  {part}
                </span>
              );
            }
            if (part.startsWith("loops=")) {
              return (
                <span key={j} className="text-purple-300">
                  {part}
                </span>
              );
            }
            if (part.startsWith("cost=")) {
              return (
                <span key={j} className="text-orange-300">
                  {part}
                </span>
              );
            }
            return <span key={j}>{part}</span>;
          })}
        </div>
      );
    });
  }, [text]);

  return (
    <div className="flex-1 overflow-auto p-4">
      <pre className="text-xs font-mono text-[var(--color-text-primary)] leading-5">
        {highlighted}
      </pre>
    </div>
  );
}

export function ExplainPanel() {
  const explainResult = useResultStore((s) => s.explainResult);
  const explainAnalyze = useResultStore((s) => s.explainAnalyze);
  const [viewMode, setViewMode] = useState<ViewMode>("table");

  if (!explainResult) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
        Run EXPLAIN to see the execution plan
      </div>
    );
  }

  if (explainAnalyze) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1">
          <span className="text-[10px] font-medium text-[var(--color-text-secondary)]">
            EXPLAIN ANALYZE
          </span>
        </div>
        <AnalyzeView result={explainResult} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1">
        <span className="mr-2 text-[10px] font-medium text-[var(--color-text-secondary)]">
          EXPLAIN
        </span>
        <button
          onClick={() => setViewMode("table")}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
            viewMode === "table"
              ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          }`}
        >
          <Table2 className="h-3 w-3" />
          Table
        </button>
        <button
          onClick={() => setViewMode("tree")}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
            viewMode === "tree"
              ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          }`}
        >
          <GitBranch className="h-3 w-3" />
          Tree
        </button>

        {/* Legend for type badges */}
        <div className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
          <span>Access type:</span>
          {Object.entries(TYPE_RANK)
            .sort((a, b) => a[1] - b[1])
            .filter(([k]) => k !== "NULL")
            .map(([type]) => (
              <span
                key={type}
                className={`rounded px-1 py-0.5 text-[9px] font-semibold ${getTypeColor(type)}`}
              >
                {type}
              </span>
            ))}
          <span className="ml-1 opacity-60">worst → best</span>
        </div>
      </div>

      {viewMode === "table" ? <ExplainTable result={explainResult} /> : <ExplainTreeView result={explainResult} />}
    </div>
  );
}
