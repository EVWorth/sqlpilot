import { AlertCircle, Loader2, Sparkles } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useEditorStore } from "../../stores/editorStore";
import type { QueryResult } from "../../types";

/**
 * What the results pane shows when there is no grid to draw: running, failed,
 * a statement that returned a count, or nothing run yet.
 *
 * Split out of ResultsGrid (#406). Four early returns that each end the
 * render sat above the component's real work, which made the shape of the
 * file harder to see than the states themselves are.
 */

export interface GridPlaceholderProps {
  isExecuting: boolean;
  error: string | null;
  result: QueryResult | undefined;
}

/**
 * The caller decides there is nothing to draw; this decides what to say about
 * it. Returns null only if called when there *is* a grid to render, which the
 * caller's own guard rules out.
 */
export function GridPlaceholder({
  isExecuting,
  error,
  result,
}: GridPlaceholderProps) {
  const aiEnabled = useAiStore((s) => s.aiEnabled);

  if (isExecuting) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Executing query...
      </div>
    );
  }

  if (error) {
    const fixWithAi = () => {
      if (!aiEnabled) return;
      const editorTab = useEditorStore.getState().tabs.find(
        (t) => t.id === useEditorStore.getState().activeTabId,
      );
      const sql = editorTab?.content ?? "";
      if (!sql.trim()) return;
      useAiStore.getState().sendMessage(
        `Fix this SQL query that produced an error:\n\nQuery:\n\`\`\`sql\n${sql}\n\`\`\`\n\nError:\n${error}`,
      );
    };

    return (
      <div className="flex h-full items-center justify-center gap-2 p-4">
        <div className="max-w-lg rounded border border-red-800 bg-red-900/20 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-red-400">
            <AlertCircle className="h-4 w-4" />
            Query Error
          </div>
          <pre className="mt-2 whitespace-pre-wrap text-xs text-red-300">{error}</pre>
          {aiEnabled && (
            <button
              onClick={fixWithAi}
              className="mt-3 flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-500"
            >
              <Sparkles className="h-3 w-3" />
              Fix with AI
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!result || result.columns.length === 0) {
    // A statement that changed rows returned no columns, which is not the
    // same as nothing having been run.
    if (result && result.rows_affected >= 0) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">
          Query executed. {result.rows_affected} row(s) affected. ({result.execution_time_ms}ms)
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
        Execute a query to see results
      </div>
    );
  }

  return null;
}
