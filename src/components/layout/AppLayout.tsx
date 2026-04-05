import { useState, useCallback } from "react";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { MainPanel } from "./MainPanel";
import { Toolbar } from "./Toolbar";
import { ShortcutsDialog } from "../common/ShortcutsDialog";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";

export function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const toggleSidebar = useCallback(
    () => setSidebarCollapsed((prev) => !prev),
    [],
  );
  const openShortcuts = useCallback(() => setShowShortcuts(true), []);
  const openSaveFavorite = useCallback(() => {
    window.dispatchEvent(new CustomEvent("open-save-favorite"));
  }, []);

  useKeyboardShortcuts(toggleSidebar, openShortcuts, openSaveFavorite);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <Toolbar onShowShortcuts={openShortcuts} />
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
          <Panel defaultSize={sidebarCollapsed ? 100 : 80} minSize={40}>
            <MainPanel />
          </Panel>
        </PanelGroup>
      </div>
      <StatusBar />
      <ShortcutsDialog
        isOpen={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />
    </div>
  );
}
