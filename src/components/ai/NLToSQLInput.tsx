import { useState, useCallback } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useEditorStore } from "../../stores/editorStore";
import { useConnectionStore } from "../../stores/connectionStore";

export function NLToSQLInput() {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateSql = useAiStore((s) => s.generateSql);
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const activeConnection = activeConnections.find(
    (c) => c.id === selectedConnectionId,
  );

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const sql = await generateSql(
        prompt,
        selectedConnectionId ?? undefined,
        activeConnection?.database ?? undefined,
      );
      // Insert into editor
      const editor = useEditorStore.getState().editorInstance;
      if (editor) {
        const position = editor.getPosition();
        if (position) {
          editor.executeEdits("ai-nl-to-sql", [
            {
              range: {
                startLineNumber: position.lineNumber,
                startColumn: position.column,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              },
              text: sql + "\n",
            },
          ]);
          editor.focus();
        }
      } else {
        // No editor instance — open a new tab with the SQL
        const tabId = useEditorStore.getState().addTab(
          selectedConnectionId ?? undefined,
          activeConnection?.database ?? undefined,
        );
        useEditorStore.getState().updateTabContent(tabId, sql);
      }
      setPrompt("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [prompt, loading, generateSql, selectedConnectionId, activeConnection]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleGenerate();
      }
    },
    [handleGenerate],
  );

  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3 w-3 text-brand-400 shrink-0" />
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe a query in plain English..."
          className="flex-1 bg-transparent text-[10px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
        />
        <button
          onClick={handleGenerate}
          disabled={!prompt.trim() || loading}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-brand-400 hover:bg-brand-600/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            "Generate"
          )}
        </button>
      </div>
      {error && (
        <p className="mt-0.5 text-[9px] text-red-400 truncate">{error}</p>
      )}
    </div>
  );
}
