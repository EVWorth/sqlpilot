import { useState, useCallback, useEffect } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { MainPanel } from "./MainPanel";
import { Toolbar } from "./Toolbar";
import { TitleBar } from "./TitleBar";
import { ConnectionTabs } from "./ConnectionTabs";
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
import { useEditorStore } from "../../stores/editorStore";
import { useAiStore } from "../../stores/aiStore";
import { useSchemaCache } from "../../hooks/useSchemaCache";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isMac = navigator.platform.toLowerCase().includes("mac");

export function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [helpTab, setHelpTab] = useState<"shortcuts" | "about">("shortcuts");
  const [showImport, setShowImport] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [backupPreselect, setBackupPreselect] = useState<{
    connectionId?: string;
    database?: string;
  }>({});
  const [restorePreselect, setRestorePreselect] = useState<{
    connectionId?: string;
    database?: string;
  }>({});
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const selectedConnection = activeConnections.find((c) => c.id === selectedConnectionId);
  const confirmDialog = useResultStore((s) => s.confirmDialog);
  const confirmExecution = useResultStore((s) => s.confirmExecution);
  const cancelExecution = useResultStore((s) => s.cancelExecution);
  const aiEnabled = useAiStore((s) => s.aiEnabled);

  useTheme();

  const toggleSidebar = useCallback(
    () => setSidebarCollapsed((prev) => !prev),
    [],
  );
  const toggleAiPanel = useCallback(
    () => setAiPanelOpen((prev) => !prev),
    [],
  );
  const openShortcuts = useCallback(() => { setHelpTab("shortcuts"); setShowShortcuts(true); }, []);
  const openImport = useCallback(() => setShowImport(true), []);
  const openBackup = useCallback(() => {
    setBackupPreselect({});
    setShowBackup(true);
  }, []);
  const openRestore = useCallback(() => {
    setRestorePreselect({});
    setShowRestore(true);
  }, []);
  const openSaveFavorite = useCallback(() => {
    window.dispatchEvent(new CustomEvent("open-save-favorite"));
  }, []);

  useKeyboardShortcuts(toggleSidebar, openShortcuts, openSaveFavorite);

  // Check AI availability on mount
  useEffect(() => {
    useAiStore.getState().checkStatus();
  }, []);

  // Handle menu actions from both native OS menu (macOS via Tauri event) and
  // inline custom menu (Windows/Linux via DOM CustomEvent)
  useEffect(() => {
    const handleAction = (action: string) => {
      const { selectedConnectionId, activeConnections, disconnect } = useConnectionStore.getState();
      const { addTab, addAdminTab, addCompareTab, addQueryBuilderTab, editorInstance } = useEditorStore.getState();
      const selectedConn = activeConnections.find((c) => c.id === selectedConnectionId);

      switch (action) {
        case "new-query":
          addTab(selectedConnectionId ?? undefined);
          break;
        case "import":
          if (selectedConnectionId) setShowImport(true);
          break;
        case "backup":
          setBackupPreselect({});
          setShowBackup(true);
          break;
        case "restore":
          setRestorePreselect({});
          setShowRestore(true);
          break;
        case "undo":
          editorInstance?.trigger("menu", "undo", null);
          break;
        case "redo":
          editorInstance?.trigger("menu", "redo", null);
          break;
        case "cut":
          document.execCommand("cut");
          break;
        case "copy":
          document.execCommand("copy");
          break;
        case "paste":
          document.execCommand("paste");
          break;
        case "select-all":
          if (editorInstance) {
            editorInstance.trigger("menu", "editor.action.selectAll", null);
          } else {
            document.execCommand("selectAll");
          }
          break;
        case "find":
          editorInstance?.getAction("actions.find")?.run();
          break;
        case "find-replace":
          editorInstance?.getAction("editor.action.startFindReplaceAction")?.run();
          break;
        case "new-connection":
          window.dispatchEvent(new CustomEvent("open-new-connection"));
          break;
        case "disconnect":
          if (selectedConnectionId) disconnect(selectedConnectionId);
          break;
        case "refresh-schema":
          useSchemaCache.getState().refreshSchema();
          break;
        case "query-builder":
          if (selectedConnectionId && selectedConn?.database) {
            addQueryBuilderTab(selectedConnectionId, selectedConn.database);
          }
          break;
        case "compare-schemas":
          addCompareTab();
          break;
        case "admin-tools":
          if (selectedConnectionId) addAdminTab(selectedConnectionId);
          break;
        case "format-sql":
          editorInstance?.getAction("format-sql")?.run();
          break;
        case "ai-assistant":
          if (useAiStore.getState().aiEnabled) setAiPanelOpen((prev) => !prev);
          break;
        case "keyboard-shortcuts":
          setHelpTab("shortcuts");
          setShowShortcuts(true);
          break;
        case "about":
          setHelpTab("about");
          setShowShortcuts(true);
          break;
        case "quit":
          getCurrentWindow().close();
          break;
      }
    };

    // DOM event — inline MenuBar (Windows/Linux)
    const domHandler = (e: Event) => handleAction((e as CustomEvent<string>).detail);
    window.addEventListener("menu-action", domHandler);

    // Tauri event — native OS menu (macOS)
    const tauriUnlisten = listen<string>("menu-action", (event) => handleAction(event.payload));

    return () => {
      window.removeEventListener("menu-action", domHandler);
      tauriUnlisten.then((fn) => fn());
    };
  }, []);

  // Listen for sidebar context menu events
  useEffect(() => {
    const handleOpenBackup = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setBackupPreselect({
        connectionId: detail?.connectionId,
        database: detail?.database,
      });
      setShowBackup(true);
    };
    const handleOpenRestore = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setRestorePreselect({
        connectionId: detail?.connectionId,
        database: detail?.database,
      });
      setShowRestore(true);
    };
    window.addEventListener("open-backup", handleOpenBackup);
    window.addEventListener("open-restore", handleOpenRestore);
    return () => {
      window.removeEventListener("open-backup", handleOpenBackup);
      window.removeEventListener("open-restore", handleOpenRestore);
    };
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      {!isMac && (
        <TitleBar
          onShowImport={openImport}
          onShowBackup={openBackup}
          onShowRestore={openRestore}
          onToggleAI={toggleAiPanel}
          aiPanelOpen={aiPanelOpen}
          aiEnabled={aiEnabled}
        />
      )}
      {isMac && (
        <Toolbar
          onShowImport={openImport}
          onShowBackup={openBackup}
          onShowRestore={openRestore}
          onToggleAI={toggleAiPanel}
          aiPanelOpen={aiPanelOpen}
          aiEnabled={aiEnabled}
        />
      )}
      <ConnectionTabs />
      <div className="flex-1 overflow-hidden">
        <Group orientation="horizontal">
          {!sidebarCollapsed && (
            <>
              <Panel defaultSize="20%" minSize="15%" maxSize="40%">
                <Sidebar />
              </Panel>
              <Separator className="w-1 bg-[var(--color-border)] hover:bg-brand-500 transition-colors" />
            </>
          )}
          <Panel defaultSize={sidebarCollapsed && !(aiPanelOpen && aiEnabled) ? "100%" : sidebarCollapsed ? "75%" : aiPanelOpen && aiEnabled ? "55%" : "80%"} minSize="30%">
            <MainPanel />
          </Panel>
          {aiEnabled && aiPanelOpen && (
            <>
              <Separator className="w-1 bg-[var(--color-border)] hover:bg-brand-500 transition-colors" />
              <Panel defaultSize="25%" minSize="15%" maxSize="40%">
                <AIChatPanel onClose={() => setAiPanelOpen(false)} />
              </Panel>
            </>
          )}
        </Group>
      </div>
      <StatusBar />
      <ShortcutsDialog
        isOpen={showShortcuts}
        onClose={() => setShowShortcuts(false)}
        initialTab={helpTab}
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
        preSelectedConnectionId={backupPreselect.connectionId}
        preSelectedDatabase={backupPreselect.database}
      />
      <RestoreDialog
        isOpen={showRestore}
        onClose={() => setShowRestore(false)}
        preSelectedConnectionId={restorePreselect.connectionId}
        preSelectedDatabase={restorePreselect.database}
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
