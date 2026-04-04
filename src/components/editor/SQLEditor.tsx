import { useCallback, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { useConnectionStore } from "../../stores/connectionStore";

export function SQLEditor() {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const updateTabContent = useEditorStore((s) => s.updateTabContent);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const handleMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor;
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
          let sql = "";
          if (selection && !selection.isEmpty()) {
            sql = model?.getValueInRange(selection) ?? "";
          } else {
            sql = model?.getValue() ?? "";
          }
          // Read current state directly to avoid stale closure
          const connectionId =
            useConnectionStore.getState().selectedConnectionId;
          if (sql.trim() && connectionId) {
            useResultStore.getState().executeQuery(connectionId, sql);
          }
        },
      });
    },
    [],
  );

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
      theme="vs-dark"
      value={activeTab.content}
      onChange={(value) => {
        if (activeTab) {
          updateTabContent(activeTab.id, value ?? "");
        }
      }}
      onMount={handleMount}
      options={{
        fontSize: 13,
        fontFamily:
          "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
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
        },
        padding: { top: 8, bottom: 8 },
      }}
    />
  );
}
