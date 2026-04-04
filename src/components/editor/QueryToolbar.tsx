import { Play, Square, Database } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { useConnectionStore } from "../../stores/connectionStore";

export function QueryToolbar() {
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const executeQuery = useResultStore((s) => s.executeQuery);
  const isExecuting = useResultStore((s) => s.isExecuting);
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const activeConnections = useConnectionStore((s) => s.activeConnections);

  const activeConnection = activeConnections.find(
    (c) => c.id === selectedConnectionId,
  );

  const handleExecute = () => {
    if (!activeTab?.content?.trim() || !selectedConnectionId || isExecuting)
      return;
    executeQuery(selectedConnectionId, activeTab.content);
  };

  const canExecute =
    !!activeTab?.content?.trim() && !!selectedConnectionId && !isExecuting;

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
