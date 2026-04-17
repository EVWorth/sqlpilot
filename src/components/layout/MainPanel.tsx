import { useState, useEffect } from "react";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { SQLEditor } from "../editor/SQLEditor";
import { EditorTabs } from "../editor/EditorTabs";
import { QueryToolbar } from "../editor/QueryToolbar";
import { ResultsGrid } from "../grid/ResultsGrid";
import { ExplainPanel } from "../explain/ExplainPanel";
import { AdminPanel } from "../admin/AdminPanel";
import { SchemaCompare } from "../compare/SchemaCompare";
import { RoutineViewer } from "../routine/RoutineViewer";
import { TableDesigner } from "../designer/TableDesigner";
import { QueryBuilder } from "../querybuilder/QueryBuilder";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";

export function MainPanel() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const showExplain = useResultStore((s) => s.showExplain);
  const explainResult = useResultStore((s) => s.explainResult);
  const setShowExplain = useResultStore((s) => s.setShowExplain);

  const isAdmin = activeTab?.type === "admin";
  const isCompare = activeTab?.type === "compare";
  const isRoutine = activeTab?.type === "routine";
  const isDesigner = activeTab?.type === "designer";
  const isQueryBuilder = activeTab?.type === "querybuilder";

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary)]">
      <EditorTabs />
      {isAdmin && activeTab?.connectionId ? (
        <AdminPanel connectionId={activeTab.connectionId} />
      ) : isCompare ? (
        <SchemaCompare />
      ) : isDesigner && activeTab?.connectionId && activeTab?.database ? (
        <TableDesigner
          connectionId={activeTab.connectionId}
          database={activeTab.database}
          tableName={activeTab.tableName}
        />
      ) : isQueryBuilder && activeTab?.connectionId && activeTab?.database ? (
        <QueryBuilder
          connectionId={activeTab.connectionId}
          database={activeTab.database}
        />
      ) : isRoutine && activeTab?.connectionId && activeTab?.database && activeTab?.routineName && activeTab?.routineType ? (
        <RoutineViewer
          connectionId={activeTab.connectionId}
          database={activeTab.database}
          routineName={activeTab.routineName}
          routineType={activeTab.routineType as "PROCEDURE" | "FUNCTION"}
        />
      ) : (
        <>
          <QueryToolbar />
          <PanelGroup direction="vertical" autoSaveId="editor-results">
            <Panel defaultSize={50} minSize={20}>
              <SQLEditor />
            </Panel>
            <PanelResizeHandle className="h-1 bg-[var(--color-border)] transition-colors hover:bg-brand-500" />
            <Panel defaultSize={50} minSize={20}>
              <ResultsPanel
                showExplain={showExplain}
                explainResult={explainResult}
                setShowExplain={setShowExplain}
              />
            </Panel>
          </PanelGroup>
        </>
      )}
    </div>
  );
}

function ResultsPanel({
  showExplain,
  explainResult,
  setShowExplain,
}: {
  showExplain: boolean;
  explainResult: unknown;
  setShowExplain: (v: boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<"results" | "explain">("results");
  const results = useResultStore((s) => s.results);

  // Auto-switch to explain tab whenever a new explain result arrives
  useEffect(() => {
    if (explainResult) {
      setActiveTab("explain");
    }
  }, [explainResult]);

  // Switch back to results tab when a new query result arrives
  useEffect(() => {
    if (results.length > 0) {
      setActiveTab("results");
    }
  }, [results]);

  const hasExplain = showExplain && !!explainResult;

  return (
    <div className="flex h-full flex-col">
      {hasExplain && (
        <div className="flex border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <button
            onClick={() => setActiveTab("results")}
            className={`px-3 py-1 text-xs transition-colors ${
              activeTab === "results"
                ? "border-b-2 border-brand-500 text-[var(--color-text-primary)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            }`}
          >
            Results
          </button>
          <button
            onClick={() => setActiveTab("explain")}
            className={`flex items-center gap-1 px-3 py-1 text-xs transition-colors ${
              activeTab === "explain"
                ? "border-b-2 border-brand-500 text-[var(--color-text-primary)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            }`}
          >
            📊 Explain
          </button>
          <button
            onClick={() => {
              setShowExplain(false);
              setActiveTab("results");
            }}
            className="ml-auto px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            title="Close Explain"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {hasExplain && activeTab === "explain" ? (
          <ExplainPanel />
        ) : (
          <ResultsGrid />
        )}
      </div>
    </div>
  );
}
