import Editor, { type OnMount, useMonaco } from "@monaco-editor/react";
import type { editor, IDisposable } from "monaco-editor";
import { useCallback, useEffect, useRef } from "react";
import { useSchemaCompletion } from "../../hooks/useSchemaCompletion";
import { createCompletionProvider } from "../../lib/schema-completion-provider";
import { formatSql } from "../../lib/sql-format";
import { getStatementAtCursor } from "../../lib/statement-at-cursor";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { useSchemaStore } from "../../stores/schemaStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";

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
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const schemaCache = useSchemaCompletion(selectedConnectionId);
  // FR-2.3.7. The minimap was hard-disabled with no way to turn it on (#295).
  const showMinimap = useSettingsStore((s) => s.querySettings.showMinimap);

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
          const model = editor.getModel();
          const selection = editor.getSelection();
          let sql;
          if (selection && !selection.isEmpty()) {
            sql = model?.getValueInRange(selection) ?? "";
          } else if (model && selection) {
            sql = getStatementAtCursor(
              model.getValue(),
              selection.positionLineNumber,
              selection.positionColumn,
            );
          } else {
            sql = model?.getValue() ?? "";
          }
          const connectionId = useConnectionStore.getState().selectedConnectionId;
          const { tabs: editorTabs, activeTabId: editorActiveTabId } = useEditorStore.getState();
          const editorActiveTab = editorTabs.find((t) => t.id === editorActiveTabId);
          if (sql?.trim() && connectionId) {
            useResultStore.getState().executeQuery(connectionId, sql, editorActiveTab?.database);
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
          const model = editor.getModel();
          const sql = model?.getValue() ?? "";
          const connectionId = useConnectionStore.getState().selectedConnectionId;
          const { tabs: editorTabs, activeTabId: editorActiveTabId } = useEditorStore.getState();
          const editorActiveTab = editorTabs.find((t) => t.id === editorActiveTabId);
          if (sql.trim() && connectionId) {
            useResultStore.getState().executeQuery(connectionId, sql, editorActiveTab?.database);
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
          const model = ed.getModel();
          const selection = ed.getSelection();
          let sql;
          if (selection && !selection.isEmpty()) {
            sql = model?.getValueInRange(selection) ?? "";
          } else {
            sql = model?.getValue() ?? "";
          }
          const connectionId = useConnectionStore.getState().selectedConnectionId;
          if (sql.trim() && connectionId) {
            useResultStore.getState().executeExplain(connectionId, sql);
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
          const model = ed.getModel();
          const selection = ed.getSelection();
          let sql;
          if (selection && !selection.isEmpty()) {
            sql = model?.getValueInRange(selection) ?? "";
          } else {
            sql = model?.getValue() ?? "";
          }
          const connectionId = useConnectionStore.getState().selectedConnectionId;
          const { tabs: editorTabs, activeTabId: editorActiveTabId } = useEditorStore.getState();
          const editorActiveTab = editorTabs.find((t) => t.id === editorActiveTabId);
          if (sql.trim() && connectionId) {
            useResultStore.getState().executeExplainAnalyze(connectionId, sql, editorActiveTab?.database);
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
      theme={effectiveTheme === "dark" ? "vs-dark" : "vs"}
      value={activeTab.content}
      onChange={(value) => {
        if (activeTab) {
          debouncedUpdateTabContent(activeTab.id, value ?? "");
        }
      }}
      onMount={handleMount}
      options={{
        fontSize: 13,
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
