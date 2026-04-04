import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { MainPanel } from "./MainPanel";
import { Toolbar } from "./Toolbar";

export function AppLayout() {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <Toolbar />
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal" autoSaveId="main-layout">
          <Panel defaultSize={20} minSize={15} maxSize={40}>
            <Sidebar />
          </Panel>
          <PanelResizeHandle className="w-1 bg-[var(--color-border)] hover:bg-brand-500 transition-colors" />
          <Panel defaultSize={80} minSize={40}>
            <MainPanel />
          </Panel>
        </PanelGroup>
      </div>
      <StatusBar />
    </div>
  );
}
