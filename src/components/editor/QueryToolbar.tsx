import {
  ChevronDown,
  Database,
  ListTree,
  Play,
  RefreshCw,
  Replace,
  Search,
  Settings2,
  Square,
  Star,
  Wand2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQueryExecution } from "../../hooks/useQueryExecution";
import { formatSql } from "../../lib/sql-format";
import { sqlAtCursor } from "../../lib/statement-at-cursor";
import { cn } from "../../lib/utils";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { schemaFor, useSchemaStore } from "../../stores/schemaStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTransactionStore } from "../../stores/transactionStore";
import { EnvironmentBadge } from "../connection/EnvironmentBadge";
import { SaveFavoriteDialog } from "../favorites/SaveFavoriteDialog";
import { FormatterSettingsDialog } from "./FormatterSettingsDialog";
import { RowLimitInput } from "./RowLimitInput";

export function QueryToolbar() {
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showFormatterSettings, setShowFormatterSettings] = useState(false);
  const formatterSettings = useSettingsStore((s) => s.formatterSettings);

  // Listen for Ctrl+S event from keyboard shortcuts
  useEffect(() => {
    const handler = () => setShowSaveDialog(true);
    window.addEventListener("open-save-favorite", handler);
    return () => window.removeEventListener("open-save-favorite", handler);
  }, []);

  const editorInstance = useEditorStore((s) => s.editorInstance);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const refreshAll = useSchemaStore((s) => s.refreshAll);
  const schemaLoading = useSchemaStore((s) =>
    selectedConnectionId ? schemaFor(s, selectedConnectionId).loading.length > 0 : false
  );

  const {
    executeQuery,
    executeExplain,
    executeExplainAnalyze,
    canExecute: hookCanExecute,
    isExecuting,
  } = useQueryExecution();

  const cancelActiveQuery = useResultStore((s) => s.cancelActiveQuery);
  // The tab's session is inside a transaction (#843).
  const transactionOpen = useTransactionStore((s) => (activeTabId ? Boolean(s.open[activeTabId]) : false));

  const activeConnection = activeConnections.find(
    (c) => c.id === selectedConnectionId,
  );
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfile = activeConnection ? profiles.find((p) => p.id === activeConnection.profile_id) : undefined;
  const environment = activeProfile?.environment ?? activeConnection?.environment ?? null;

  const handleExecute = () => {
    if (!hookCanExecute) return;
    // An open suggestion list would sit over the results (#853).
    useEditorStore.getState().editorInstance?.trigger("run", "hideSuggestWidget", null);
    const sql = getCurrentSql();
    if (!sql.trim()) return;
    executeQuery(sql);
  };

  const [explainOpen, setExplainOpen] = useState(false);
  const explainRef = useRef<HTMLDivElement>(null);
  const explainToggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (explainRef.current && !explainRef.current.contains(e.target as Node)) {
        setExplainOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Escape closes the Explain menu, as it does any menu (#853).
  useEffect(() => {
    if (!explainOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setExplainOpen(false);
      explainToggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [explainOpen]);

  const getCurrentSql = (): string => {
    const editorInstance = useEditorStore.getState().editorInstance;
    // The statement at the cursor, as Ctrl+Enter runs — the hint beside Run
    // names that shortcut, and Explain cannot plan a whole script (#846).
    if (editorInstance) return sqlAtCursor(editorInstance);
    return activeTab?.content ?? "";
  };

  const handleExplain = () => {
    if (!hookCanExecute) return;
    const sql = getCurrentSql();
    if (!sql.trim()) return;
    executeExplain(sql);
    setExplainOpen(false);
  };

  const handleExplainAnalyze = () => {
    if (!hookCanExecute) return;
    const sql = getCurrentSql();
    if (!sql.trim()) return;
    executeExplainAnalyze(sql);
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
    model.setValue(formatSql(value, formatterSettings));
  };

  const canExecute = !!activeTab?.content?.trim() && hookCanExecute;

  // min-h-6/min-w-6 keeps every one of these at the 24px floor WCAG 2.2 asks
  // for (SC 2.5.8) without changing the icons, which are fine at 12px — it is
  // the box around them that was 20px tall.
  const toolbarBtnClass =
    "flex min-h-6 min-w-6 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  // Labels and the shortcut hint give way to icons as the bar narrows,
  // measured on the bar itself rather than the window, since the sidebar and
  // agent panel take their share. At 1024px wide "Find", "Replace" and
  // "Format" were drawn on top of each other (#838).
  const label = "hidden @min-[54rem]:inline";

  return (
    <div
      data-environment={environment ?? undefined}
      className={cn(
        "@container flex h-8 min-w-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2",
        // A production server tints the bar the Run button sits in, so the
        // last thing seen before running is which kind of server it is (#835).
        environment === "production" && "surface-error border-t-2 border-t-[var(--color-error)]",
      )}
    >
      <button
        onClick={isExecuting ? cancelActiveQuery : handleExecute}
        disabled={!isExecuting && !canExecute}
        title={isExecuting ? "Cancel Query" : "Run statement at cursor (Ctrl+Enter / F9); Ctrl+Shift+Enter runs all"}
        className={`flex w-20 shrink-0 items-center justify-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          isExecuting
            ? "bg-red-600 text-white hover:bg-red-700"
            : "bg-green-700 text-white hover:bg-green-800 disabled:hover:bg-green-700"
        }`}
      >
        {isExecuting
          ? (
            <>
              <Square className="h-3 w-3 fill-current" />
              Cancel
            </>
          )
          : (
            <>
              <Play className="h-3 w-3 fill-current" />
              Run
            </>
          )}
      </button>

      <span className="hidden whitespace-nowrap text-[10px] text-[var(--color-text-muted)] @min-[58rem]:inline">
        Ctrl+Enter / F9
      </span>

      <div className="relative shrink-0 whitespace-nowrap" ref={explainRef}>
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
            ref={explainToggleRef}
            onClick={() => setExplainOpen((v) => !v)}
            disabled={!canExecute}
            aria-label="Explain options"
            aria-haspopup="menu"
            aria-expanded={explainOpen}
            className="flex min-h-6 min-w-6 items-center justify-center rounded-r border border-l-0 border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-1 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
              title="Measures the plan by running the statement"
              className="flex w-full items-start gap-2 px-3 py-1.5 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
            >
              <ListTree className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="flex flex-col items-start">
                EXPLAIN ANALYZE
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  runs the query
                </span>
              </span>
            </button>
          </div>
        )}
      </div>

      {transactionOpen && (
        <div
          role="status"
          className="flex items-center gap-1 rounded border edge-warning surface-warning px-1.5 py-0.5 text-[11px] text-[var(--color-warning)]"
        >
          <span className="font-medium">Transaction open</span>
          <button
            onClick={() => void executeQuery("COMMIT")}
            disabled={isExecuting}
            className="rounded px-1.5 py-0.5 font-medium underline-offset-2 hover:underline disabled:opacity-40"
          >
            Commit
          </button>
          <button
            onClick={() => void executeQuery("ROLLBACK")}
            disabled={isExecuting}
            className="rounded px-1.5 py-0.5 font-medium underline-offset-2 hover:underline disabled:opacity-40"
          >
            Rollback
          </button>
        </div>
      )}

      <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

      <button
        onClick={handleFind}
        disabled={!editorInstance}
        title="Find (Ctrl+F)"
        aria-label="Find (Ctrl+F)"
        className={toolbarBtnClass}
      >
        <Search className="h-3 w-3" />
        <span className={label}>Find</span>
      </button>

      <button
        onClick={handleReplace}
        disabled={!editorInstance}
        title="Replace (Ctrl+H)"
        aria-label="Replace (Ctrl+H)"
        className={toolbarBtnClass}
      >
        <Replace className="h-3 w-3" />
        <span className={label}>Replace</span>
      </button>

      <button
        onClick={handleFormat}
        disabled={!editorInstance}
        title="Format SQL (Ctrl+Shift+F)"
        aria-label="Format SQL (Ctrl+Shift+F)"
        className={toolbarBtnClass}
      >
        <Wand2 className="h-3 w-3" />
        <span className={label}>Format</span>
      </button>

      <button
        onClick={() => setShowFormatterSettings(true)}
        disabled={!editorInstance}
        title="Formatter Settings"
        className={toolbarBtnClass}
      >
        <Settings2 className="h-3 w-3" />
      </button>

      <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

      <button
        onClick={() => selectedConnectionId && void refreshAll(selectedConnectionId)}
        disabled={!selectedConnectionId || schemaLoading}
        title="Refresh Schema Cache"
        aria-label="Refresh Schema Cache"
        className={toolbarBtnClass}
      >
        <RefreshCw className={`h-3 w-3 ${schemaLoading ? "animate-spin" : ""}`} />
        <span className={label}>Schema</span>
      </button>

      <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

      <RowLimit />

      <div className="mx-1 h-4 w-px bg-[var(--color-border)]" />

      <button
        onClick={() => setShowSaveDialog(true)}
        disabled={!activeTab?.content?.trim()}
        title="Save as Favorite (Ctrl+S)"
        aria-label="Save as Favorite (Ctrl+S)"
        className={toolbarBtnClass}
      >
        <Star className="h-3 w-3" />
        <span className={label}>Save</span>
      </button>

      <div className="flex-1" />

      {activeConnection && (
        <div
          className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-[var(--color-text-muted)]"
          title={`${activeProfile?.name || activeConnection.name} (${activeConnection.host}:${activeConnection.port})`}
        >
          <EnvironmentBadge environment={environment} />
          <Database className="h-3 w-3 shrink-0" />
          {/* Named as the profile is now; the host is where the session really is (#831). */}
          <span className="truncate">{activeProfile?.name || activeConnection.name}</span>
          <span className="hidden opacity-50 @min-[64rem]:inline">
            ({activeConnection.host}:{activeConnection.port})
          </span>
        </div>
      )}

      <SaveFavoriteDialog
        isOpen={showSaveDialog}
        onClose={() => setShowSaveDialog(false)}
        sql={activeTab?.content ?? ""}
        connectionName={activeProfile?.name || activeConnection?.name}
        database={activeTab?.database}
        onSaved={(sql) => {
          if (activeTab) useEditorStore.getState().markTabSaved(activeTab.id, sql);
        }}
      />

      <FormatterSettingsDialog
        isOpen={showFormatterSettings}
        onClose={() => setShowFormatterSettings(false)}
        // The user's own statement, so the preview shows their code rather
        // than a sample they have to translate from (#355).
        sample={editorInstance?.getModel()?.getValue()}
      />
    </div>
  );
}

function RowLimit() {
  const { limitEnabled, maxResultRows } = useSettingsStore((s) => s.querySettings);
  const setQuerySettings = useSettingsStore((s) => s.setQuerySettings);

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        onClick={() =>
          setQuerySettings({
            ...useSettingsStore.getState().querySettings,
            limitEnabled: !limitEnabled,
          })}
        title={limitEnabled ? "Disable row limit" : "Enable row limit"}
        aria-pressed={limitEnabled}
        className={`flex items-center rounded px-1.5 py-1 text-xs transition-colors ${
          limitEnabled
            ? "bg-[var(--color-accent)] text-white"
            : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
        }`}
      >
        LIMIT
      </button>
      {limitEnabled && (
        <RowLimitInput
          value={maxResultRows}
          onChange={(val) =>
            setQuerySettings({
              ...useSettingsStore.getState().querySettings,
              maxResultRows: val,
            })}
        />
      )}
    </div>
  );
}
