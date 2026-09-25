import { useCallback } from "react";
import { useConnectionStore } from "../stores/connectionStore";
import { useEditorStore } from "../stores/editorStore";
import { useResultStore } from "../stores/resultStore";

/**
 * The editor toolbar's execution context, pre-bound.
 *
 * Deliberately scoped to the editor, and named for what it does rather than
 * what it once claimed. The old comment said it "centralizes query execution
 * context so callers never have to thread connectionId/database manually",
 * which read as a general abstraction that eleven other features were ignoring
 * (#448). They were not ignoring it — they could not use it. It resolves the
 * connection and database from the *selected connection and active editor tab*,
 * which is the wrong answer for a dialog that already knows which connection
 * it was opened for.
 *
 * The centralizing that issue wanted does exist, one layer down: every
 * statement the app runs goes through `lib/run-statement.ts` or
 * `resultStore.executeQuery`, and nothing calls `api.executeQuery` directly
 * any more (#586). This hook sits above that and answers a narrower question —
 * what would the Run button run?
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
  // The tab's own server session, so what one run sets up is there for the
  // next (#731). Only a query tab has one; the others are views of an object.
  const session = activeTab?.type === "query" ? activeTab.id : undefined;

  const executeQuery = useCallback(
    (sql: string) => {
      if (!connectionId) return Promise.reject(new Error("No active connection"));
      return storeExecuteQuery(connectionId, sql, database, session);
    },
    [connectionId, database, session, storeExecuteQuery],
  );

  const executeExplain = useCallback(
    (sql: string) => {
      if (!connectionId) return Promise.reject(new Error("No active connection"));
      return storeExecuteExplain(connectionId, sql, database, undefined, session);
    },
    [connectionId, database, session, storeExecuteExplain],
  );

  const executeExplainAnalyze = useCallback(
    (sql: string) => {
      if (!connectionId) return Promise.reject(new Error("No active connection"));
      return storeExecuteExplainAnalyze(connectionId, sql, database, undefined, session);
    },
    [connectionId, database, session, storeExecuteExplainAnalyze],
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
