import { CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
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

// Keys that are internal plumbing and shouldn't be shown to the user
const HIDDEN_ARG_KEYS = new Set(["connection_id"]);

/** Build a human-readable command string for the collapsed summary */
function buildCommandSummary(toolName: string, args?: Record<string, unknown>): string | null {
  if (!args) return null;
  const db = args.database as string | undefined;
  const table = args.table as string | undefined;

  switch (toolName) {
    case "list_databases":
      return "SHOW DATABASES";
    case "list_tables":
      return db ? `SHOW TABLES FROM \`${db}\`` : null;
    case "describe_table":
      return db && table ? `DESCRIBE \`${db}\`.\`${table}\`` : null;
    case "get_table_ddl":
      return db && table ? `SHOW CREATE TABLE \`${db}\`.\`${table}\`` : null;
    case "run_select_query":
    case "run_query": {
      const sql = (args.sql ?? args.query) as string | undefined;
      return sql || null;
    }
    case "explain_query": {
      const sql = (args.sql ?? args.query) as string | undefined;
      return sql ? `EXPLAIN ${sql}` : null;
    }
    case "list_routines":
      return db ? `SHOW ROUTINES FROM \`${db}\`` : null;
    case "show_process_list":
      return "SHOW PROCESSLIST";
    default: {
      // Fallback: show visible args as key=value
      const visible = Object.entries(args).filter(([k]) => !HIDDEN_ARG_KEYS.has(k));
      if (visible.length === 0) return null;
      return visible
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ");
    }
  }
}

interface ToolCallBlockProps {
  tool: ToolExecution;
}

export function ToolCallBlock({ tool }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_LABELS[tool.name] || tool.name;
  const command = buildCommandSummary(tool.name, tool.arguments);
  const hasDetails = !!(tool.result || command);

  return (
    <div className="my-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[10px]">
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        {tool.status === "running"
          ? <Loader2 className="h-3 w-3 animate-spin text-brand-400 shrink-0" />
          : tool.status === "done"
          ? <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
          : <XCircle className="h-3 w-3 text-red-400 shrink-0" />}
        <span className="flex-1 font-medium text-[var(--color-text-secondary)] truncate">
          {label}
          {command && (
            <span className="ml-1 font-normal text-[var(--color-text-muted)]">
              — <code className="font-mono">{command.length > 80 ? command.slice(0, 80) + "…" : command}</code>
            </span>
          )}
        </span>
        {hasDetails && (
          expanded
            ? <ChevronDown className="h-3 w-3 text-[var(--color-text-muted)] shrink-0" />
            : <ChevronRight className="h-3 w-3 text-[var(--color-text-muted)] shrink-0" />
        )}
      </button>
      {expanded && hasDetails && (
        <div className="border-t border-[var(--color-border)] px-2 py-1.5 space-y-1">
          {command && (
            <div>
              <span className="text-[9px] font-semibold uppercase text-[var(--color-text-muted)]">Command</span>
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-brand-300 font-mono">
                {command}
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
