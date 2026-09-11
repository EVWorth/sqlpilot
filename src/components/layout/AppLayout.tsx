import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useTheme } from "../../hooks/useTheme";
import { useAiStore } from "../../stores/aiStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDialogStore } from "../../stores/dialogStore";
import { useEditorStore } from "../../stores/editorStore";
import { useProductionGuardStore } from "../../stores/productionGuardStore";
import type { PendingKind } from "../../stores/resultStore";
import { useResultStore } from "../../stores/resultStore";
import { useSchemaCacheStore } from "../../stores/schemaCacheStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import { AIChatPanel } from "../ai/AIChatPanel";
import { BackupDialog } from "../backup/BackupDialog";
import { RestoreDialog } from "../backup/RestoreDialog";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { ShortcutsDialog } from "../common/ShortcutsDialog";
import { HistoryQuickOpen } from "../history/HistoryQuickOpen";
import { ImportDialog } from "../import/ImportDialog";
import { ThemeSettingsDialog } from "../settings/ThemeSettingsDialog";
import { ConnectionTabs } from "./ConnectionTabs";
import { MainPanel } from "./MainPanel";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { Toolbar } from "./Toolbar";

const isMac = navigator.platform.toLowerCase().includes("mac");

/**
 * Wording for the production confirmation, chosen by what is pending.
 *
 * EXPLAIN ANALYZE gets its own copy because the risk is different: the query is
 * not necessarily destructive, it is that ANALYZE runs what it measures (#412).
 */
const CONFIRM_COPY: Record<PendingKind, { title: string; message: string; confirm: string }> = {
  "query": {
    title: "⚠️ Destructive Query on Production",
    message:
      "You are about to run a destructive query (DROP, DELETE, TRUNCATE, or ALTER) on a PRODUCTION database. Are you sure you want to proceed?",
    confirm: "Execute Anyway",
  },
  "explain-analyze": {
    title: "⚠️ EXPLAIN ANALYZE on Production",
    message:
      "EXPLAIN ANALYZE measures the query by running it. This is a PRODUCTION database, so the statement will really execute and consume real resources.\n\nUse plain EXPLAIN to see the plan without running anything.",
    confirm: "Run It Anyway",
  },
};

export function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Which dialog is open lives in a store, so the menu dispatcher, the
  // sidebar's context menus and the toolbar can all open one without reaching
  // into this component (#450).
  const openDialogName = useDialogStore((s) => s.open);
  const dialogTarget = useDialogStore((s) => s.target);
  const helpTab = useDialogStore((s) => s.helpTab);
  const openDialog = useDialogStore((s) => s.openDialog);
  const closeDialog = useDialogStore((s) => s.closeDialog);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const selectedConnection = activeConnections.find((c) => c.id === selectedConnectionId);
  const confirmDialog = useResultStore((s) => s.confirmDialog);
  const guardRequest = useProductionGuardStore((s) => s.pending);
  const answerGuard = useProductionGuardStore((s) => s.answer);
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
  const openShortcuts = useCallback(() => useDialogStore.getState().openHelp("shortcuts"), []);
  const openImport = useCallback(() => openDialog("import"), [openDialog]);
  const openBackup = useCallback(() => openDialog("backup"), [openDialog]);
  const openRestore = useCallback(() => openDialog("restore"), [openDialog]);
  const openSaveFavorite = useCallback(() => {
    window.dispatchEvent(new CustomEvent("open-save-favorite"));
  }, []);

  const [showHistoryPicker, setShowHistoryPicker] = useState(false);
  const openHistoryPicker = useCallback(() => setShowHistoryPicker(true), []);

  /** Put a statement from the picker into the active tab, or a new one. */
  const insertFromHistory = useCallback((sql: string) => {
    const store = useEditorStore.getState();
    const active = store.tabs.find((t) => t.id === store.activeTabId);
    if (active) {
      store.updateTabContent(active.id, sql);
      return;
    }
    store.updateTabContent(store.addTab(), sql);
  }, []);

  useKeyboardShortcuts(toggleSidebar, openShortcuts, openSaveFavorite, openHistoryPicker);

  // Check AI availability on mount
  useEffect(() => {
    useAiStore.getState().checkStatus();
  }, []);

  // Handle menu actions from both native OS menu (macOS via Tauri event) and
  // inline custom menu (Windows/Linux via DOM CustomEvent)
  useEffect(() => {
    const handleAction = (action: string) => {
      const { selectedConnectionId, disconnect } = useConnectionStore.getState();
      const { addTab, addAdminTab, editorInstance } = useEditorStore.getState();

      switch (action) {
        case "new-query":
          addTab(selectedConnectionId ?? undefined);
          break;
        case "import":
          if (selectedConnectionId) useDialogStore.getState().openDialog("import");
          break;
        case "backup":
          useDialogStore.getState().openDialog("backup");
          break;
        case "restore":
          useDialogStore.getState().openDialog("restore");
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
          useSchemaCacheStore.getState().refreshSchema();
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
          useDialogStore.getState().openHelp("shortcuts");
          break;
        case "check-for-updates":
          void useSettingsStore.getState().checkForUpdates();
          break;
        case "appearance":
          useDialogStore.getState().openDialog("appearance");
          break;
        case "cycle-theme":
          // Reaches here from the inline MenuBar (Windows/Linux) and from the
          // native Help menu on macOS, which is the surface #453 was about.
          useThemeStore.getState().cycleTheme();
          break;
        case "about":
          useDialogStore.getState().openHelp("about");
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
    const openFromEvent = (dialog: "backup" | "restore") => (e: Event) => {
      const detail = (e as CustomEvent).detail;
      useDialogStore.getState().openDialog(dialog, {
        connectionId: detail?.connectionId,
        database: detail?.database,
      });
    };
    const handleOpenBackup = openFromEvent("backup");
    const handleOpenRestore = openFromEvent("restore");
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
          <Panel
            defaultSize={sidebarCollapsed && !(aiPanelOpen && aiEnabled)
              ? "100%"
              : sidebarCollapsed
              ? "75%"
              : aiPanelOpen && aiEnabled
              ? "55%"
              : "80%"}
            minSize="30%"
          >
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
        isOpen={openDialogName === "help"}
        onClose={closeDialog}
        initialTab={helpTab}
      />
      {selectedConnectionId && selectedConnection && (
        <ImportDialog
          isOpen={openDialogName === "import"}
          onClose={closeDialog}
          connectionId={selectedConnectionId}
          database={selectedConnection.database ?? ""}
        />
      )}
      <BackupDialog
        isOpen={openDialogName === "backup"}
        onClose={closeDialog}
        preSelectedConnectionId={dialogTarget.connectionId}
        preSelectedDatabase={dialogTarget.database}
      />
      <RestoreDialog
        isOpen={openDialogName === "restore"}
        onClose={closeDialog}
        preSelectedConnectionId={dialogTarget.connectionId}
        preSelectedDatabase={dialogTarget.database}
      />
      <ThemeSettingsDialog
        isOpen={openDialogName === "appearance"}
        onClose={closeDialog}
      />
      <HistoryQuickOpen
        isOpen={showHistoryPicker}
        onClose={() => setShowHistoryPicker(false)}
        onPick={insertFromHistory}
      />
      <ConfirmDialog
        isOpen={!!confirmDialog?.isOpen}
        title={CONFIRM_COPY[confirmDialog?.kind ?? "query"].title}
        message={CONFIRM_COPY[confirmDialog?.kind ?? "query"].message}
        confirmLabel={CONFIRM_COPY[confirmDialog?.kind ?? "query"].confirm}
        cancelLabel="Cancel"
        danger
        onConfirm={confirmExecution}
        onCancel={cancelExecution}
      />
      {
        /* The awaitable gate (#588). Separate from the one above because that
          one runs the statement itself, while this one only answers yes or no
          and leaves the caller to carry on. */
      }
      <ConfirmDialog
        isOpen={!!guardRequest}
        title={guardRequest?.title ?? ""}
        message={guardRequest?.message ?? ""}
        confirmLabel={guardRequest?.confirmLabel ?? "Run anyway"}
        cancelLabel="Cancel"
        danger
        onConfirm={() => answerGuard(true)}
        onCancel={() => answerGuard(false)}
      />
    </div>
  );
}
