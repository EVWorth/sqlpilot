import { Play, Square, Database, Search, Replace, Wand2, RefreshCw } from "lucide-react";
import { format } from "sql-formatter";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useSchemaCache } from "../../hooks/useSchemaCache";

export function QueryToolbar() {
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const editorInstance = useEditorStore((s) => s.editorInstance);
  const executeQuery = useResultStore((s) => s.executeQuery);
  const isExecuting = useResultStore((s) => s.isExecuting);
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const refreshSchema = useSchemaCache((s) => s.refreshSchema);
  const schemaLoading = useSchemaCache((s) => s.loading);

  const activeConnection = activeConnections.find(
    (c) => c.id === selectedConnectionId,
  );

  const handleExecute = () => {
    if (!selectedConnectionId || isExecuting) return;

    const editorInstance = useEditorStore.getState().editorInstance;
    let sql = "";
    if (editorInstance) {
      const selection = editorInstance.getSelection();
      const model = editorInstance.getModel();
      if (selection && !selection.isEmpty()) {
        sql = model?.getValueInRange(selection) ?? "";
      } else {
        sql = model?.getValue() ?? "";
      }
    } else {
      sql = activeTab?.content ?? "";
    }

    if (!sql.trim()) return;
    executeQuery(selectedConnectionId, sql);
  };

  const handleFind = () => {
    editorInstance?.getAction("actions.find")?.run();
  };

  const handleReplace = () => {
    editorInstance?.getAction("editor.action.startFindReplaceAction")?.run();
  };

  const handleFormat = () => {
    if (!editorInstance) return;
    const model = editorInstance.getModel();
    if (!model) return;
    const value = model.getValue();
    if (!value.trim()) return;
    try {
      const formatted = format(value, {
        language: "mysql",
        keywordCase: "upper",
        tabWidth: 2,
      });
      model.setValue(formatted);
    } catch {
      // If formatting fails, leave content unchanged
    }
  };

  const canExecute =
    !!activeTab?.content?.trim() && !!selectedConnectionId && !isExecuting;

  const toolbarBtnClass =
    "flex items-center gap-1 rounded px-1.5 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="flex h-8 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2">
      <button
        onClick={handleExecute}
        disabled={!canExecute}
        title="Execute Query (Ctrl+Enter)"
        className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-green-600 text-white hover:bg-green-500 disabled:hover:bg-green-600"
      >
        {isExecuting ? (
          <>
            <Square className="h-3 w-3" />
            Running...
          </>
        ) : (
          <>
            <Play className="h-3 w-3 fill-current" />
            Run
          </>
        )}
      </button>

      <span className="text-[10px] text-[var(--color-text-muted)]">
        Ctrl+Enter
      </span>

      <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

      <button
        onClick={handleFind}
        disabled={!editorInstance}
        title="Find (Ctrl+F)"
        className={toolbarBtnClass}
      >
        <Search className="h-3 w-3" />
        Find
      </button>

      <button
        onClick={handleReplace}
        disabled={!editorInstance}
        title="Replace (Ctrl+H)"
        className={toolbarBtnClass}
      >
        <Replace className="h-3 w-3" />
        Replace
      </button>

      <button
        onClick={handleFormat}
        disabled={!editorInstance}
        title="Format SQL (Ctrl+Shift+F)"
        className={toolbarBtnClass}
      >
        <Wand2 className="h-3 w-3" />
        Format
      </button>

      <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

      <button
        onClick={() => refreshSchema()}
        disabled={!selectedConnectionId || schemaLoading}
        title="Refresh Schema Cache"
        className={toolbarBtnClass}
      >
        <RefreshCw className={`h-3 w-3 ${schemaLoading ? "animate-spin" : ""}`} />
        Schema
      </button>

      <div className="flex-1" />

      {activeConnection && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
          <Database className="h-3 w-3" />
          <span>{activeConnection.name}</span>
          <span className="opacity-50">
            ({activeConnection.host}:{activeConnection.port})
          </span>
        </div>
      )}
    </div>
  );
}
