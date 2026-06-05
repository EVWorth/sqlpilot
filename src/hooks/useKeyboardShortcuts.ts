import { useEffect } from "react";
import { useEditorStore } from "../stores/editorStore";
import { useResultStore } from "../stores/resultStore";
import { useConnectionStore } from "../stores/connectionStore";

export function useKeyboardShortcuts(
  onToggleSidebar?: () => void,
  onShowShortcuts?: () => void,
  onSaveFavorite?: () => void,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const target = e.target as HTMLElement;
      const isMonacoFocused =
        target.closest(".monaco-editor") != null &&
        target.tagName === "TEXTAREA";

      // F1 — shortcuts help (only when Monaco doesn't have focus)
      if (e.key === "F1" && !isMonacoFocused) {
        e.preventDefault();
        onShowShortcuts?.();
        return;
      }

      // F5 — execute query
      if (e.key === "F5") {
        e.preventDefault();
        const connectionId =
          useConnectionStore.getState().selectedConnectionId;
        const { tabs, activeTabId } = useEditorStore.getState();
        const activeTab = tabs.find((t) => t.id === activeTabId);
        if (activeTab?.content?.trim() && connectionId) {
          useResultStore.getState().executeQuery(connectionId, activeTab.content, activeTab.database);
        }
        return;
      }

      if (!ctrl) return;

      // Ctrl+S — save favorite (only when Monaco editor is focused)
      if (!shift && e.key === "s" && isMonacoFocused) {
        e.preventDefault();
        onSaveFavorite?.();
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs
      if (e.key === "Tab") {
        e.preventDefault();
        const { tabs, activeTabId } = useEditorStore.getState();
        if (tabs.length <= 1) return;
        const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
        if (currentIndex === -1) return;
        const nextIndex = shift
          ? (currentIndex - 1 + tabs.length) % tabs.length
          : (currentIndex + 1) % tabs.length;
        useEditorStore.getState().setActiveTab(tabs[nextIndex].id);
        return;
      }

      // Ctrl+N or Ctrl+T — new tab
      if (!shift && (e.key === "n" || e.key === "t")) {
        e.preventDefault();
        useEditorStore.getState().addTab();
        return;
      }

      // Ctrl+W — close active tab
      if (!shift && e.key === "w") {
        e.preventDefault();
        const { activeTabId } = useEditorStore.getState();
        if (activeTabId) {
          useEditorStore.getState().closeTab(activeTabId);
        }
        return;
      }

      // Ctrl+Shift+C — toggle sidebar
      if (shift && e.key === "C") {
        e.preventDefault();
        onToggleSidebar?.();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onToggleSidebar, onShowShortcuts, onSaveFavorite]);
}
