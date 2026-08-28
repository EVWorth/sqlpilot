import { AlertTriangle, GitBranch, Square, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useResultStore } from "../../stores/resultStore";
import type { QueryResult, SqlValue } from "../../types";

type ViewMode = "table" | "tree";

/**
 * Every access type MySQL's EXPLAIN can report, worst to best.
 *
 * One ordered list rather than parallel rank and colour maps: the legend, the
 * ordering and the badge colour all have to agree, and keeping them in three
 * places is what left index_merge and friends rendering as an unexplained grey
 * badge with no legend entry (#426).
 */
const ACCESS_TYPES: ReadonlyArray<{ type: string; color: string }> = [
  { type: "ALL", color: "bg-red-600/80 text-white" },
  { type: "index", color: "bg-yellow-600/80 text-white" },
  { type: "index_merge", color: "bg-yellow-700/80 text-white" },
  { type: "range", color: "bg-yellow-500/70 text-white" },
  { type: "index_subquery", color: "bg-lime-600/80 text-white" },
  { type: "unique_subquery", color: "bg-lime-500/80 text-white" },
  { type: "ref_or_null", color: "bg-green-700/80 text-white" },
  { type: "fulltext", color: "bg-purple-600/80 text-white" },
  { type: "spatial", color: "bg-pink-600/80 text-white" },
  { type: "ref", color: "bg-green-600/80 text-white" },
  { type: "eq_ref", color: "bg-green-500/80 text-white" },
  { type: "const", color: "bg-blue-500/80 text-white" },
  { type: "system", color: "bg-blue-500/80 text-white" },
];

const TYPE_COLORS: Record<string, string> = Object.fromEntries(
  ACCESS_TYPES.map(({ type, color }) => [type, color]),
);

function getTypeColor(type: string): string {
  return TYPE_COLORS[type] ?? "bg-gray-600/80 text-white";
}

export interface ExplainRow {
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
  /**
   * Measured counterparts to `rows`/`filtered`, present only in MariaDB's
   * ANALYZE output. Null when the server did not report them — the whole point
   * of running ANALYZE is the gap between the estimate and these.
   */
  r_rows: number | null;
  r_filtered: number | null;
  Extra: string;
}

export function parseExplainRows(result: QueryResult): ExplainRow[] {
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
    // Distinguishes "column absent" from "column present and zero".
    const getOptionalNum = (name: string): number | null => {
      if (!colNames.includes(name.toLowerCase())) return null;
      const v = get(name);
      return v === "" ? null : Number(v);
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
      r_rows: getOptionalNum("r_rows"),
      r_filtered: getOptionalNum("r_filtered"),
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

function ExplainTable({ rows, maxRows }: { rows: ExplainRow[]; maxRows: number }) {
  // MariaDB's ANALYZE reports what actually happened alongside the estimate.
  // Show those columns only when the server sent them (#422).
  const hasMeasured = rows.some((r) => r.r_rows !== null || r.r_filtered !== null);

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
              ...(hasMeasured ? ["r_rows"] : []),
              "filtered",
              ...(hasMeasured ? ["r_filtered"] : []),
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
              {hasMeasured && (
                <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-right tabular-nums text-[var(--color-text-primary)]">
                  {row.r_rows === null ? "—" : row.r_rows.toLocaleString()}
                </td>
              )}
              <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-[var(--color-text-muted)]">
                {row.filtered ? `${row.filtered}%` : "—"}
              </td>
              {hasMeasured && (
                <td className="border-b border-r border-[var(--color-border)] px-2 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">
                  {row.r_filtered === null ? "—" : `${row.r_filtered}%`}
                </td>
              )}
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

export interface TreeNode {
  table: string;
  type: string;
  rows: number;
  filtered: number;
  key: string;
  selectType: string;
  extra: string;
  children: TreeNode[];
}

/**
 * The ids a synthetic table name refers to.
 *
 * MySQL names the inputs it materialises: `<union1,2>` on a UNION RESULT row,
 * `<derived2>` for a materialised derived table, `<subquery3>` for a
 * materialised subquery. These are explicit parent→child edges — far better
 * evidence than guessing from id ordering.
 */
export function referencedIds(table: string): number[] {
  const match = /^<(?:union|derived|subquery)(\d+(?:,\d+)*)>$/i.exec(table.trim());
  if (!match) return [];
  return match[1].split(",").map(Number);
}

/**
 * Rebuild the plan tree from tabular EXPLAIN rows.
 *
 * Two rules, in order of how much MySQL tells us:
 *
 *   1. Rows sharing an `id` belong to one SELECT — they are the join order for
 *      that block, and stay siblings.
 *   2. A row naming `<union1,2>`/`<derivedN>` adopts those id groups as its
 *      children. Otherwise a group nests under the nearest preceding group with
 *      a lower id, which is the standard reading of EXPLAIN's numbering.
 *
 * The previous version made every later id group a child of the first group's
 * last node, which flattened UNIONs into unrelated top-level nodes and lost the
 * UNION RESULT that ties them together (#423).
 */
export function buildTree(rows: ExplainRow[]): TreeNode[] {
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
  if (nodes.length <= 1) return nodes;

  // A UNION RESULT row carries no id of its own on MySQL 5.7. Give it one just
  // past its members so it sorts after them but before the next real group.
  const explicitChildren = new Map<number, number[]>();
  const ids: number[] = rows.map((r, i) => {
    const refs = referencedIds(rows[i].table);
    if (r.id !== null && r.id !== "") return Number(r.id);
    return refs.length ? Math.max(...refs) + 0.5 : 0;
  });
  rows.forEach((r, i) => {
    const refs = referencedIds(r.table);
    if (refs.length) explicitChildren.set(ids[i], refs);
  });

  const groups = new Map<number, TreeNode[]>();
  ids.forEach((id, i) => {
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(nodes[i]);
  });

  // An id claimed as someone's explicit child must not also be placed by the
  // id-ordering fallback, or it would appear twice.
  const claimed = new Set<number>();
  for (const refs of explicitChildren.values()) {
    refs.forEach((id) => claimed.add(id));
  }

  const sortedIds = [...groups.keys()].sort((a, b) => a - b);
  const root: TreeNode[] = [];

  for (const id of sortedIds) {
    const group = groups.get(id)!;
    if (claimed.has(id)) continue;

    // Nearest preceding group that is itself placed in the tree.
    const parentId = sortedIds
      .filter((candidate) => candidate < id && !claimed.has(candidate))
      .pop();
    if (parentId === undefined) {
      root.push(...group);
    } else {
      const siblings = groups.get(parentId)!;
      siblings[siblings.length - 1].children.push(...group);
    }
  }

  // Attach explicit children last, so a UNION RESULT owns its branches wherever
  // it ended up.
  for (const [ownerId, refs] of explicitChildren) {
    const owner = groups.get(ownerId);
    if (!owner) continue;
    const target = owner[owner.length - 1];
    for (const refId of refs) {
      const child = groups.get(refId);
      if (child) target.children.push(...child);
    }
  }

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

function ExplainTreeView({ rows, maxRows }: { rows: ExplainRow[]; maxRows: number }) {
  const tree = useMemo(() => buildTree(rows), [rows]);

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

/**
 * Shown when ANALYZE was asked for but the backend planned instead — the user
 * needs to know the timings are missing on purpose, not that ANALYZE failed.
 */
function DowngradeNotice({ notice }: { notice: string }) {
  return (
    <div className="flex items-start gap-2 border-b border-[var(--color-border)] bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-400" />
      <span>{notice}</span>
    </div>
  );
}

/**
 * Cancel affordance for the plan panel.
 *
 * ANALYZE runs the statement, so a slow one leaves the user watching a spinner.
 * The toolbar has a Cancel button, but not while attention is on this panel
 * (#427). Cancellation is real — it issues KILL QUERY server-side.
 */
function CancelButton() {
  const cancelActiveQuery = useResultStore((s) => s.cancelActiveQuery);
  return (
    <button
      onClick={() => void cancelActiveQuery()}
      title="Cancel the running statement"
      className="ml-2 flex items-center gap-1 rounded bg-red-600/90 px-1.5 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-red-500"
    >
      <Square className="h-2.5 w-2.5 fill-current" />
      Cancel
    </button>
  );
}

export function ExplainPanel() {
  const explainResult = useResultStore((s) => s.explainResult);
  const explainAnalyze = useResultStore((s) => s.explainAnalyze);
  const explainNotice = useResultStore((s) => s.explainNotice);
  const explainTabular = useResultStore((s) => s.explainTabular);
  const isExecuting = useResultStore((s) => s.isExecuting);
  const [viewMode, setViewMode] = useState<ViewMode>("table");

  // Parsed once here and passed down. Each view used to parse the result for
  // itself, so a single render walked every row three times (#425).
  const rows = useMemo(
    () => (explainResult ? parseExplainRows(explainResult) : []),
    [explainResult],
  );
  const maxRows = useMemo(
    () => Math.max(...rows.map((r) => r.rows), 1),
    [rows],
  );

  if (!explainResult) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
        Run EXPLAIN to see the execution plan
      </div>
    );
  }

  // MySQL's EXPLAIN ANALYZE answers with one column of TREE text, which the
  // raw-text view is built for. MariaDB's ANALYZE answers with the same columns
  // as EXPLAIN — joining those with newlines produced a wall of one word per
  // line, so it belongs in the normal views (#422).
  if (explainAnalyze && !explainTabular) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1">
          <span className="text-[10px] font-medium text-[var(--color-text-secondary)]">
            EXPLAIN ANALYZE
          </span>
          {isExecuting && <CancelButton />}
        </div>
        {explainNotice && <DowngradeNotice notice={explainNotice} />}
        <AnalyzeView result={explainResult} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1">
        <span className="mr-2 text-[10px] font-medium text-[var(--color-text-secondary)]">
          {explainAnalyze ? "ANALYZE" : "EXPLAIN"}
        </span>
        {isExecuting && <CancelButton />}
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
          {ACCESS_TYPES.map(({ type, color }) => (
            <span
              key={type}
              className={`rounded px-1 py-0.5 text-[9px] font-semibold ${color}`}
            >
              {type}
            </span>
          ))}
          <span className="ml-1 opacity-60">worst → best</span>
        </div>
      </div>

      {explainNotice && <DowngradeNotice notice={explainNotice} />}

      {viewMode === "table"
        ? <ExplainTable rows={rows} maxRows={maxRows} />
        : <ExplainTreeView rows={rows} maxRows={maxRows} />}
    </div>
  );
}
