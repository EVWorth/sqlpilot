import Editor, { type OnMount, useMonaco } from "@monaco-editor/react";
import type { editor, IDisposable } from "monaco-editor";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useSchemaCompletion } from "../../hooks/useSchemaCompletion";
import { statementRange } from "../../lib/error-marker";
import { monacoThemeData, monacoThemeName } from "../../lib/monaco-theme";
import { runConnectionId } from "../../lib/run-connection";
import { createCompletionProvider } from "../../lib/schema-completion-provider";
import { formatSql } from "../../lib/sql-format";
import { sqlAtCursor } from "../../lib/statement-at-cursor";
import { useConnectionStore } from "../../stores/connectionStore";
import { setPendingContentFlush, useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { useSchemaStore } from "../../stores/schemaStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSqliteStore } from "../../stores/sqliteStore";
import { useThemeStore } from "../../stores/themeStore";

/**
 * The active tab's connection, database and server session, for the editor's
 * own actions.
 *
 * Read at the moment an action runs rather than captured when the editor
 * mounted, since the keybindings outlive any one tab. The session keeps the
 * tab's statements on its own connection (#731); only a query tab has one.
 */
function activeTabContext(): { connectionId?: string; database?: string; session?: string } {
  const { tabs, activeTabId } = useEditorStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  const { selectedConnectionId, activeConnections } = useConnectionStore.getState();
  const live = [
    ...activeConnections.map((c) => c.id),
    ...useSqliteStore.getState().sessions.map((s) => s.id),
  ];
  return {
    // The server the tab is marked with, not whichever is selected (#788).
    connectionId: runConnectionId(tab, selectedConnectionId, live),
    database: tab?.database,
    session: tab?.type === "query" ? tab.id : undefined,
  };
}

/** Who owns the markers a failed run leaves, so they replace only each other. */
const RUN_MARKER_OWNER = "sqlpilot-run";

export function SQLEditor() {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const providerRef = useRef<IDisposable | null>(null);
  const inlineProviderRef = useRef<IDisposable | null>(null);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const updateTabContent = useEditorStore((s) => s.updateTabContent);
  const setEditorInstance = useEditorStore((s) => s.setEditorInstance);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const effectiveTheme = useThemeStore((s) => s.effectiveTheme);

  // Debounce store updates on keystroke to avoid excessive re-renders.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ tabId: string; content: string } | null>(null);

  /** Write whatever the last keystroke left waiting, now. */
  const flushPending = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) updateTabContent(pending.tabId, pending.content);
  }, [updateTabContent]);

  // Unmounting used to drop the timer without running it, so the last 150ms
  // of typing was lost — switching tabs or closing the window at the wrong
  // moment silently threw away a line (#298 F-backlog). Flush instead.
  useEffect(() => flushPending, [flushPending]);

  // A close reads the store, which is up to 150 ms behind the keyboard: Ctrl+W
  // right after typing found an empty tab and closed it unasked (#861).
  useEffect(() => {
    setPendingContentFlush(flushPending);
    return () => setPendingContentFlush(null);
  }, [flushPending]);

  const debouncedUpdateTabContent = useCallback(
    (tabId: string, content: string) => {
      // A pending write is for the tab it was typed in. Switching tabs before
      // the timer fires has to land it there, not on the new one.
      if (pendingRef.current && pendingRef.current.tabId !== tabId) flushPending();
      pendingRef.current = { tabId, content };
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending) updateTabContent(pending.tabId, pending.content);
      }, 150);
    },
    [updateTabContent, flushPending],
  );

  const monaco = useMonaco();
  // The editor in the app theme's colours, not vs-dark or vs by base alone
  // (#838). Defined in a layout effect, so it exists before the editor's own
  // effect applies the `theme` prop; redefined and reapplied when a custom
  // theme is edited under the same name.
  const activeTheme = useThemeStore((s) => s.activeTheme);
  const editorTheme = monaco && activeTheme
    ? monacoThemeName(activeTheme)
    : effectiveTheme === "dark"
    ? "vs-dark"
    : "vs";
  useLayoutEffect(() => {
    if (!monaco || !activeTheme) return;
    monaco.editor.defineTheme(monacoThemeName(activeTheme), monacoThemeData(activeTheme));
    monaco.editor.setTheme(monacoThemeName(activeTheme));
  }, [monaco, activeTheme]);
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const schemaCache = useSchemaCompletion(selectedConnectionId);
  // FR-2.3.7. The minimap was hard-disabled with no way to turn it on (#295).
  const showMinimap = useSettingsStore((s) => s.querySettings.showMinimap);
  // Was a hard-coded 13 (#837).
  const fontSize = useSettingsStore((s) => s.querySettings.editorFontSize);

  // Load enough for autocomplete to be useful as soon as a connection is
  // chosen, rather than on the first keystroke that needs it.
  useEffect(() => {
    if (selectedConnectionId) void useSchemaStore.getState().refreshAll(selectedConnectionId);
  }, [selectedConnectionId]);

  // Register/re-register completion provider when connection or schema changes
  useEffect(() => {
    if (!monaco) return;

    providerRef.current?.dispose();
    providerRef.current = monaco.languages.registerCompletionItemProvider(
      "sql",
      createCompletionProvider(monaco, {
        connectionId: schemaCache.connectionId,
        databases: schemaCache.databases,
        tables: schemaCache.tables,
        views: schemaCache.views,
        columns: schemaCache.columns,
        fetchTables: schemaCache.fetchTables,
        fetchViews: schemaCache.fetchViews,
        fetchColumns: schemaCache.fetchColumns,
      }),
    );

    return () => {
      providerRef.current?.dispose();
      providerRef.current = null;
    };
  }, [
    monaco,
    schemaCache.connectionId,
    schemaCache.databases,
    schemaCache.tables,
    schemaCache.views,
    schemaCache.columns,
    schemaCache.fetchTables,
    schemaCache.fetchViews,
    schemaCache.fetchColumns,
  ]);

  // Mark the statement a script failed at, so the user is shown where to look
  // rather than having to count statements (#845). Cleared by the next run.
  const failedStatement = useResultStore((s) => s.failedStatement);
  const failedError = useResultStore((s) => s.error);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    const range = failedStatement?.sql ? statementRange(model.getValue(), failedStatement.sql) : null;
    monaco.editor.setModelMarkers(
      model,
      RUN_MARKER_OWNER,
      range
        ? [{
          ...range,
          severity: monaco.MarkerSeverity.Error,
          message: failedError ?? "This statement failed",
          code: failedStatement?.code != null ? String(failedStatement.code) : undefined,
        }]
        : [],
    );
  }, [monaco, failedStatement, failedError, activeTabId]);

  const handleMount: OnMount = useCallback(
    (editor, _monacoInstance) => {
      editorRef.current = editor;
      setEditorInstance(editor);

      // Unbind Ctrl+End / Cmd+End from Monaco's "cursorBottom" so the
      // suggestion widget can use navigation instead of jumping to doc end.
      try {
        _monacoInstance.editor.addKeybindingRule({
          keybinding: 2048 | 15, // Monaco.KeyMod.CtrlCmd | Monaco.KeyCode.End
          command: null,
        });
      } catch {
        // Non-critical
      }

      editor.addAction({
        id: "execute-query",
        label: "Execute Query",
        keybindings: [
          // Monaco.KeyMod.CtrlCmd | Monaco.KeyCode.Enter
          2048 | 3,
          // Monaco.KeyCode.F9
          67,
        ],
        run: () => {
          // The suggestion list would otherwise stay open over the results (#853).
          editor.trigger("run", "hideSuggestWidget", null);
          const sql = sqlAtCursor(editor);
          const { connectionId, database, session } = activeTabContext();
          if (sql.trim() && connectionId) {
            useResultStore.getState().executeQuery(connectionId, sql, database, session);
          }
        },
      });

      editor.addAction({
        id: "format-sql",
        label: "Format SQL",
        keybindings: [
          // Monaco.KeyMod.CtrlCmd | Monaco.KeyMod.Shift | Monaco.KeyCode.KeyF
          2048 | 1024 | 36,
        ],
        run: (ed) => {
          const model = ed.getModel();
          if (!model) return;
          const value = model.getValue();
          if (!value.trim()) return;
          model.setValue(
            formatSql(value, useSettingsStore.getState().formatterSettings),
          );
        },
      });

      editor.addAction({
        id: "execute-all",
        label: "Execute All Statements",
        keybindings: [
          // Monaco.KeyMod.CtrlCmd | Monaco.KeyMod.Shift | Monaco.KeyCode.Enter
          2048 | 1024 | 3,
        ],
        run: () => {
          // The suggestion list would otherwise stay open over the results (#853).
          editor.trigger("run", "hideSuggestWidget", null);
          const model = editor.getModel();
          const sql = model?.getValue() ?? "";
          const { connectionId, database, session } = activeTabContext();
          if (sql.trim() && connectionId) {
            useResultStore.getState().executeQuery(connectionId, sql, database, session);
          }
        },
      });

      editor.addAction({
        id: "explain-query",
        label: "Explain Query",
        keybindings: [
          // Monaco.KeyMod.CtrlCmd | Monaco.KeyMod.Shift | Monaco.KeyCode.KeyE
          2048 | 1024 | 35,
        ],
        run: (ed) => {
          const sql = sqlAtCursor(ed);
          const { connectionId, database, session } = activeTabContext();
          if (sql.trim() && connectionId) {
            useResultStore.getState().executeExplain(connectionId, sql, database, undefined, session);
          }
        },
      });

      editor.addAction({
        id: "explain-analyze",
        label: "Explain Analyze",
        keybindings: [
          // Monaco.KeyMod.CtrlCmd | Monaco.KeyMod.Shift | Monaco.KeyCode.KeyA
          2048 | 1024 | 31,
        ],
        run: (ed) => {
          const sql = sqlAtCursor(ed);
          const { connectionId, database, session } = activeTabContext();
          if (sql.trim() && connectionId) {
            useResultStore.getState().executeExplainAnalyze(connectionId, sql, database, undefined, session);
          }
        },
      });

      editor.addAction({
        id: "lowercase-selected",
        label: "Lowercase selected keywords",
        keybindings: [
          // Monaco.KeyMod.CtrlCmd | Monaco.KeyMod.Shift | Monaco.KeyCode.KeyL
          2048 | 1024 | 38,
        ],
        run: () => {
          // delegate to Monaco's built-in TransformToLowercase action
          editor.trigger("keyboard", "editor.action.transformToLowercase", null);
        },
      });

      editor.addAction({
        id: "uppercase-selected",
        label: "Uppercase selected keywords",
        keybindings: [
          // Monaco.KeyMod.CtrlCmd | Monaco.KeyMod.Shift | Monaco.KeyCode.KeyU
          2048 | 1024 | 30,
        ],
        run: () => {
          editor.trigger("keyboard", "editor.action.transformToUppercase", null);
        },
      });

      editor.addAction({
        id: "refresh-schema",
        label: "Refresh Schema",
        keybindings: [
          // Monaco.KeyCode.F5
          64,
        ],
        run: async () => {
          const connectionId = useConnectionStore.getState().selectedConnectionId;
          if (connectionId) await useSchemaStore.getState().refreshAll(connectionId);
        },
      });

      // AI inline completions - disabled pending Copilot SDK streaming completion support
      inlineProviderRef.current?.dispose();
      inlineProviderRef.current = null;
    },
    [setEditorInstance],
  );

  // Clean up inline provider on unmount
  useEffect(() => {
    return () => {
      inlineProviderRef.current?.dispose();
      inlineProviderRef.current = null;
    };
  }, []);

  if (!activeTab) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
        Open a new tab to start writing SQL
      </div>
    );
  }

  return (
    <Editor
      height="100%"
      language="sql"
      theme={editorTheme}
      value={activeTab.content}
      onChange={(value) => {
        if (activeTab) {
          debouncedUpdateTabContent(activeTab.id, value ?? "");
        }
      }}
      onMount={handleMount}
      options={{
        fontSize,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        minimap: { enabled: showMinimap },
        lineNumbers: "on",
        renderLineHighlight: "line",
        scrollBeyondLastLine: false,
        wordWrap: "on",
        tabSize: 2,
        automaticLayout: true,
        suggest: {
          showKeywords: true,
          showSnippets: true,
          showWords: false,
        },
        quickSuggestions: {
          other: true,
          strings: true,
          comments: false,
        },
        inlineSuggest: { enabled: true },
        padding: { top: 8, bottom: 8 },
      }}
    />
  );
}
