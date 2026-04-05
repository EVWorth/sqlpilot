import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle } from "lucide-react";
import type { ToolExecution } from "../../types";

const TOOL_LABELS: Record<string, string> = {
  list_databases: "Listing databases",
  list_tables: "Listing tables",
  describe_table: "Describing table",
  get_table_ddl: "Getting DDL",
  run_select_query: "Running SELECT",
  explain_query: "Explaining query",
  list_routines: "Listing routines",
  show_process_list: "Showing processes",
  run_query: "Executing query",
};

function formatArgs(args?: Record<string, unknown>): string | null {
  if (!args || Object.keys(args).length === 0) return null;
  // Show SQL if present, otherwise show key=value pairs
  if (args.sql && typeof args.sql === "string") return args.sql;
  if (args.query && typeof args.query === "string") return args.query;
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

interface ToolCallBlockProps {
  tool: ToolExecution;
}

export function ToolCallBlock({ tool }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_LABELS[tool.name] || tool.name;
  const argsSummary = formatArgs(tool.arguments);
  const hasDetails = !!(tool.result || argsSummary);

  return (
    <div className="my-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[10px]">
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        {tool.status === "running" ? (
          <Loader2 className="h-3 w-3 animate-spin text-brand-400 shrink-0" />
        ) : tool.status === "done" ? (
          <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
        ) : (
          <XCircle className="h-3 w-3 text-red-400 shrink-0" />
        )}
        <span className="flex-1 font-medium text-[var(--color-text-secondary)]">
          {label}
          {argsSummary && (
            <span className="ml-1 font-normal text-[var(--color-text-muted)] truncate">
              — {argsSummary.length > 60 ? argsSummary.slice(0, 60) + "…" : argsSummary}
            </span>
          )}
        </span>
        {hasDetails && (
          expanded ? (
            <ChevronDown className="h-3 w-3 text-[var(--color-text-muted)] shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-[var(--color-text-muted)] shrink-0" />
          )
        )}
      </button>
      {expanded && hasDetails && (
        <div className="border-t border-[var(--color-border)] px-2 py-1.5 space-y-1">
          {argsSummary && (
            <div>
              <span className="text-[9px] font-semibold uppercase text-[var(--color-text-muted)]">Args</span>
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-[var(--color-text-muted)]">
                {argsSummary}
              </pre>
            </div>
          )}
          {tool.result && (
            <div>
              <span className="text-[9px] font-semibold uppercase text-[var(--color-text-muted)]">Result</span>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[var(--color-text-muted)]">
                {tool.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
