import { useState, useRef, useEffect } from "react";
import { Play, Square, Database, Search, Replace, Wand2, RefreshCw, ListTree, ChevronDown, Star } from "lucide-react";
import { format } from "sql-formatter";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useSchemaCache } from "../../hooks/useSchemaCache";
import { SaveFavoriteDialog } from "../favorites/SaveFavoriteDialog";

export function QueryToolbar() {
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  // Listen for Ctrl+S event from keyboard shortcuts
  useEffect(() => {
    const handler = () => setShowSaveDialog(true);
    window.addEventListener("open-save-favorite", handler);
    return () => window.removeEventListener("open-save-favorite", handler);
  }, []);

  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const editorInstance = useEditorStore((s) => s.editorInstance);
  const executeQuery = useResultStore((s) => s.executeQuery);
  const executeExplain = useResultStore((s) => s.executeExplain);
  const executeExplainAnalyze = useResultStore((s) => s.executeExplainAnalyze);
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
    const sql = getCurrentSql();
    if (!sql.trim()) return;
    executeQuery(selectedConnectionId, sql);
  };

  const [explainOpen, setExplainOpen] = useState(false);
  const explainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (explainRef.current && !explainRef.current.contains(e.target as Node)) {
        setExplainOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const getCurrentSql = (): string => {
    const editorInstance = useEditorStore.getState().editorInstance;
    if (editorInstance) {
      const selection = editorInstance.getSelection();
      const model = editorInstance.getModel();
      if (selection && !selection.isEmpty()) {
        return model?.getValueInRange(selection) ?? "";
      }
      return model?.getValue() ?? "";
    }
    return activeTab?.content ?? "";
  };

  const handleExplain = () => {
    if (!selectedConnectionId || isExecuting) return;
    const sql = getCurrentSql();
    if (!sql.trim()) return;
    executeExplain(selectedConnectionId, sql);
    setExplainOpen(false);
  };

  const handleExplainAnalyze = () => {
    if (!selectedConnectionId || isExecuting) return;
    const sql = getCurrentSql();
    if (!sql.trim()) return;
    executeExplainAnalyze(selectedConnectionId, sql);
    setExplainOpen(false);
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

      <div className="relative" ref={explainRef}>
        <div className="flex">
          <button
            onClick={handleExplain}
            disabled={!canExecute}
            title="Explain Query (Ctrl+Shift+E)"
            className="flex items-center gap-1 rounded-l px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)]"
          >
            <ListTree className="h-3 w-3" />
            Explain
          </button>
          <button
            onClick={() => setExplainOpen((v) => !v)}
            disabled={!canExecute}
            className="flex items-center rounded-r border border-l-0 border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-1 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
        {explainOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[160px] rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-1 shadow-lg">
            <button
              onClick={handleExplain}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
            >
              <ListTree className="h-3 w-3" />
              EXPLAIN
            </button>
            <button
              onClick={handleExplainAnalyze}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
            >
              <ListTree className="h-3 w-3" />
              EXPLAIN ANALYZE
            </button>
          </div>
        )}
      </div>

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

      <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

      <button
        onClick={() => setShowSaveDialog(true)}
        disabled={!activeTab?.content?.trim()}
        title="Save as Favorite (Ctrl+S)"
        className={toolbarBtnClass}
      >
        <Star className="h-3 w-3" />
        Save
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

      <SaveFavoriteDialog
        isOpen={showSaveDialog}
        onClose={() => setShowSaveDialog(false)}
        sql={activeTab?.content ?? ""}
        connectionName={activeConnection?.name}
        database={activeTab?.database}
      />
    </div>
  );
}
