import { useCallback } from "react";
import { useConnectionStore } from "../stores/connectionStore";
import { useEditorStore } from "../stores/editorStore";
import { useResultStore } from "../stores/resultStore";

/**
 * Centralizes query execution context so callers never have to thread
 * connectionId/database manually. Reads both from the active tab and
 * the selected connection, then exposes pre-bound execute/explain helpers.
 */
export function useQueryExecution() {
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const storeExecuteQuery = useResultStore((s) => s.executeQuery);
  const storeExecuteExplain = useResultStore((s) => s.executeExplain);
  const storeExecuteExplainAnalyze = useResultStore(
    (s) => s.executeExplainAnalyze,
  );
  const isExecuting = useResultStore((s) => s.isExecuting);

  const connectionId = selectedConnectionId ?? undefined;
  const database = activeTab?.database;

  const executeQuery = useCallback(
    (sql: string) => {
      if (!connectionId) return Promise.reject(new Error("No active connection"));
      return storeExecuteQuery(connectionId, sql, database);
    },
    [connectionId, database, storeExecuteQuery],
  );

  const executeExplain = useCallback(
    (sql: string) => {
      if (!connectionId) return Promise.reject(new Error("No active connection"));
      return storeExecuteExplain(connectionId, sql, database);
    },
    [connectionId, database, storeExecuteExplain],
  );

  const executeExplainAnalyze = useCallback(
    (sql: string) => {
      if (!connectionId) return Promise.reject(new Error("No active connection"));
      return storeExecuteExplainAnalyze(connectionId, sql, database);
    },
    [connectionId, database, storeExecuteExplainAnalyze],
  );

  const canExecute = !!connectionId && !isExecuting;

  return {
    executeQuery,
    executeExplain,
    executeExplainAnalyze,
    canExecute,
    isExecuting,
    connectionId,
    database,
  };
}
