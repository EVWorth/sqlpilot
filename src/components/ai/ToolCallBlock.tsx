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

interface ToolCallBlockProps {
  tool: ToolExecution;
}

export function ToolCallBlock({ tool }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_LABELS[tool.name] || tool.name;

  return (
    <div className="my-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[10px]">
      <button
        onClick={() => setExpanded(!expanded)}
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
        </span>
        {tool.result && (
          expanded ? (
            <ChevronDown className="h-3 w-3 text-[var(--color-text-muted)] shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-[var(--color-text-muted)] shrink-0" />
          )
        )}
      </button>
      {expanded && tool.result && (
        <div className="border-t border-[var(--color-border)] px-2 py-1.5">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[var(--color-text-muted)]">
            {tool.result}
          </pre>
        </div>
      )}
    </div>
  );
}
