import Editor from "@monaco-editor/react";
import { AlertCircle, Check, Copy, FileCode, Loader2, Pencil, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ddlKey, type DdlTarget, useDdlStore } from "../../stores/ddlStore";
import { useEditorStore } from "../../stores/editorStore";
import { useThemeStore } from "../../stores/themeStore";

const buttonClass =
  "flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)] disabled:opacity-50";

/**
 * An object's DDL, read-only, with Copy and "Open in editor" (#800).
 *
 * The text comes from the schema API rather than a `SHOW CREATE` run through
 * the results grid, where it sat ellipsized in one cell.
 */
export function DdlViewer(target: DdlTarget) {
  const { connectionId, database, objectName, objectType } = target;
  const key = ddlKey(target);
  const entry = useDdlStore((s) => s.entries[key]);
  const load = useDdlStore((s) => s.load);
  const effectiveTheme = useThemeStore((s) => s.effectiveTheme);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void load({ connectionId, database, objectName, objectType });
  }, [load, connectionId, database, objectName, objectType]);

  const reload = () => void load({ connectionId, database, objectName, objectType });
  const ddl = entry?.ddl ?? null;

  const copy = () => {
    if (ddl === null) return;
    void navigator.clipboard.writeText(ddl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const openInEditor = () => {
    if (ddl === null) return;
    const { addTab, updateTabContent } = useEditorStore.getState();
    const tabId = addTab(connectionId, database);
    updateTabContent(tabId, ddl);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--color-bg-primary)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--color-text-primary)]">
          <FileCode className="h-4 w-4" />
          <span className="text-[10px] font-semibold uppercase text-[var(--color-text-muted)]">{objectType}</span>
          <code className="text-sm text-brand-400">{database}.{objectName}</code>
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={copy} disabled={ddl === null} className={buttonClass} title="Copy DDL">
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={openInEditor}
            disabled={ddl === null}
            className={buttonClass}
            title="Open the DDL in a new query tab"
          >
            <Pencil className="h-3 w-3" />
            Open in editor
          </button>
          <button onClick={reload} className={buttonClass} title="Reload DDL" aria-label="Reload DDL">
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {entry?.error
        ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <AlertCircle className="h-6 w-6 text-[var(--color-error)]" />
            <p role="alert" className="text-sm text-[var(--color-error)]">
              Couldn't load the DDL of {objectName}: {entry.error}
            </p>
            <button
              onClick={reload}
              className="rounded bg-[var(--color-bg-tertiary)] px-3 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            >
              Retry
            </button>
          </div>
        )
        : ddl === null
        ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2
              aria-label="Loading DDL"
              className="h-6 w-6 animate-spin text-[var(--color-text-muted)]"
            />
          </div>
        )
        : (
          <div className="min-h-0 flex-1">
            <Editor
              value={ddl}
              language="sql"
              theme={effectiveTheme === "dark" ? "vs-dark" : "vs"}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                fontSize: 12,
                wordWrap: "on",
                renderLineHighlight: "none",
              }}
            />
          </div>
        )}
    </div>
  );
}
