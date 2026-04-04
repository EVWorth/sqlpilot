import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { SQLEditor } from "../editor/SQLEditor";
import { EditorTabs } from "../editor/EditorTabs";
import { ResultsGrid } from "../grid/ResultsGrid";
import { useEditorStore } from "../../stores/editorStore";

export function MainPanel() {
  const tabs = useEditorStore((s) => s.tabs);

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[var(--color-bg-primary)]">
        <h2 className="mb-2 text-lg font-medium text-[var(--color-text-secondary)]">
          Welcome to MySQL AI Studio
        </h2>
        <p className="mb-4 text-sm text-[var(--color-text-muted)]">
          Create a connection and open a new query tab to get started
        </p>
        <button
          onClick={() => useEditorStore.getState().addTab()}
          className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500"
        >
          New Query Tab
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary)]">
      <EditorTabs />
      <PanelGroup direction="vertical" autoSaveId="editor-results">
        <Panel defaultSize={50} minSize={20}>
          <SQLEditor />
        </Panel>
        <PanelResizeHandle className="h-1 bg-[var(--color-border)] transition-colors hover:bg-brand-500" />
        <Panel defaultSize={50} minSize={20}>
          <ResultsGrid />
        </Panel>
      </PanelGroup>
    </div>
  );
}
