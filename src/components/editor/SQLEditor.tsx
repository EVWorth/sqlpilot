import Editor, { type OnMount, useMonaco } from "@monaco-editor/react";
import type { editor, IDisposable } from "monaco-editor";
import { useCallback, useEffect, useRef } from "react";
import { format } from "sql-formatter";
import { useSchemaCache } from "../../hooks/useSchemaCache";
import { createCompletionProvider } from "../../lib/schema-completion-provider";
import { postProcessSQL } from "../../lib/sql-post-process";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
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

  // Debounce store updates on keystroke to avoid excessive re-renders
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string>("");
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const debouncedUpdateTabContent = useCallback(
    (tabId: string, content: string) => {
      pendingRef.current = content;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        updateTabContent(tabId, pendingRef.current);
      }, 150);
    },
    [updateTabContent],
  );

  const monaco = useMonaco();
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const schemaCache = useSchemaCache();

  // Sync schema cache with active connection
  useEffect(() => {
    schemaCache.setConnection(selectedConnectionId);
  }, [selectedConnectionId]); // eslint-disable-line react-hooks/exhaustive-deps

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
        ],
        run: () => {
          const model = editor.getModel();
          const selection = editor.getSelection();
          let sql;
          if (selection && !selection.isEmpty()) {
            sql = model?.getValueInRange(selection) ?? "";
          } else if (model && selection) {
            const fullText = model.getValue();
            const cursorLine = selection.positionLineNumber;
            const lines = fullText.split("\n");
            let charOffset = 0;
            for (let i = 0; i < cursorLine - 1; i++) {
              charOffset += lines[i].length + 1;
            }
            charOffset += selection.positionColumn - 1;

            // Find statement boundaries around the cursor by scanning for
            // semicolons or blank lines (double newline).
            let stmtStart = 0;
            let stmtEnd = fullText.length;
            // Scan backwards from cursor for \n\n or ;
            for (let i = charOffset - 1; i >= 0; i--) {
              if (fullText[i] === ";") {
                stmtStart = i + 1;
                break;
              }
              if (i > 0 && fullText[i] === "\n" && fullText[i - 1] === "\n") {
                stmtStart = i + 1;
                break;
              }
            }
            // Scan forwards from cursor for \n\n or ;
            for (let i = charOffset; i < fullText.length; i++) {
              if (fullText[i] === ";") {
                stmtEnd = i + 1;
                break;
              }
              if (i > 0 && fullText[i] === "\n" && fullText[i - 1] === "\n") {
                stmtEnd = i - 1;
                break;
              }
            }
            sql = fullText.slice(stmtStart, stmtEnd).trim();
            if (!sql && charOffset >= 0) {
              sql = fullText.trim();
            }
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
          try {
            const settings = useSettingsStore.getState().formatterSettings;
            const formatted = format(value, {
              language: "mysql",
              keywordCase: settings.keywordCase,
              identifierCase: settings.identifierCase,
              dataTypeCase: settings.dataTypeCase,
              functionCase: settings.functionCase,
              indentStyle: settings.indentStyle,
              tabWidth: settings.tabWidth,
              useTabs: settings.useTabs,
              logicalOperatorNewline: settings.logicalOperatorNewline,
              newlineBeforeSemicolon: settings.newlineBeforeSemicolon,
              expressionWidth: settings.expressionWidth,
              linesBetweenQueries: settings.linesBetweenQueries,
              denseOperators: settings.denseOperators,
            });
            model.setValue(postProcessSQL(formatted));
          } catch {
            // If formatting fails, leave content unchanged
          }
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
        minimap: { enabled: false },
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
