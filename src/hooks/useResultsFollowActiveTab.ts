import { useEffect } from "react";
import { useConnectionStore } from "../stores/connectionStore";
import { useEditorStore } from "../stores/editorStore";
import { useResultStore } from "../stores/resultStore";

/**
 * Keep the results pane on the active editor tab's own results (#842).
 *
 * Each tab keeps what it ran; switching tabs swaps them in, a tab that has run
 * nothing shows the empty state, and a closed tab's results are dropped.
 * Switching the selected connection clears a grid read on another one, which
 * would otherwise sit under the new connection's name with Edit Mode offered.
 */
export function useResultsFollowActiveTab() {
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const showTab = useResultStore((s) => s.showTab);
  const forgetTabs = useResultStore((s) => s.forgetTabs);
  const dropForeignResults = useResultStore((s) => s.dropForeignResults);

  useEffect(() => {
    showTab(activeTabId);
  }, [activeTabId, showTab]);

  useEffect(() => {
    forgetTabs(tabs.map((t) => t.id));
  }, [tabs, forgetTabs]);

  useEffect(() => {
    dropForeignResults(selectedConnectionId);
  }, [selectedConnectionId, dropForeignResults]);
}
