import { useState, useCallback } from "react";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { MainPanel } from "./MainPanel";
import { Toolbar } from "./Toolbar";
import { ShortcutsDialog } from "../common/ShortcutsDialog";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { ImportDialog } from "../import/ImportDialog";
import { BackupDialog } from "../backup/BackupDialog";
import { RestoreDialog } from "../backup/RestoreDialog";
import { AIChatPanel } from "../ai/AIChatPanel";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useTheme } from "../../hooks/useTheme";
import { useConnectionStore } from "../../stores/connectionStore";
import { useResultStore } from "../../stores/resultStore";

export function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const selectedConnection = activeConnections.find((c) => c.id === selectedConnectionId);
  const confirmDialog = useResultStore((s) => s.confirmDialog);
  const confirmExecution = useResultStore((s) => s.confirmExecution);
  const cancelExecution = useResultStore((s) => s.cancelExecution);

  useTheme();

  const toggleSidebar = useCallback(
    () => setSidebarCollapsed((prev) => !prev),
    [],
  );
  const toggleAiPanel = useCallback(
    () => setAiPanelOpen((prev) => !prev),
    [],
  );
  const openShortcuts = useCallback(() => setShowShortcuts(true), []);
  const openImport = useCallback(() => setShowImport(true), []);
  const openBackup = useCallback(() => setShowBackup(true), []);
  const openRestore = useCallback(() => setShowRestore(true), []);
  const openSaveFavorite = useCallback(() => {
    window.dispatchEvent(new CustomEvent("open-save-favorite"));
  }, []);

  useKeyboardShortcuts(toggleSidebar, openShortcuts, openSaveFavorite);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <Toolbar
        onShowShortcuts={openShortcuts}
        onShowImport={openImport}
        onShowBackup={openBackup}
        onShowRestore={openRestore}
        onToggleAI={toggleAiPanel}
        aiPanelOpen={aiPanelOpen}
      />
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal" autoSaveId="main-layout">
          {!sidebarCollapsed && (
            <>
              <Panel defaultSize={20} minSize={15} maxSize={40}>
                <Sidebar />
              </Panel>
              <PanelResizeHandle className="w-1 bg-[var(--color-border)] hover:bg-brand-500 transition-colors" />
            </>
          )}
          <Panel defaultSize={sidebarCollapsed && !aiPanelOpen ? 100 : sidebarCollapsed ? 75 : aiPanelOpen ? 55 : 80} minSize={30}>
            <MainPanel />
          </Panel>
          {aiPanelOpen && (
            <>
              <PanelResizeHandle className="w-1 bg-[var(--color-border)] hover:bg-brand-500 transition-colors" />
              <Panel defaultSize={25} minSize={15} maxSize={40}>
                <AIChatPanel onClose={() => setAiPanelOpen(false)} />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
      <StatusBar />
      <ShortcutsDialog
        isOpen={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />
      {selectedConnectionId && selectedConnection && (
        <ImportDialog
          isOpen={showImport}
          onClose={() => setShowImport(false)}
          connectionId={selectedConnectionId}
          database={selectedConnection.database ?? ""}
        />
      )}
      <BackupDialog
        isOpen={showBackup}
        onClose={() => setShowBackup(false)}
      />
      <RestoreDialog
        isOpen={showRestore}
        onClose={() => setShowRestore(false)}
      />
      <ConfirmDialog
        isOpen={!!confirmDialog?.isOpen}
        title="⚠️ Destructive Query on Production"
        message="You are about to run a destructive query (DROP, DELETE, TRUNCATE, or ALTER) on a PRODUCTION database. Are you sure you want to proceed?"
        confirmLabel="Execute Anyway"
        cancelLabel="Cancel"
        danger
        onConfirm={confirmExecution}
        onCancel={cancelExecution}
      />
    </div>
  );
}
