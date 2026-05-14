import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { format } from "sql-formatter";
import { Copy, Check, X, Download } from "lucide-react";
import { useThemeStore } from "../../stores/themeStore";

interface Props {
  isOpen: boolean;
  columnName?: string;
  content: string | null;
  dataType?: string;
  onClose: () => void;
}

type ContentType = "json" | "sql" | "markdown" | "text";

function detectContentType(content: string, dataType?: string): ContentType {
  const hint = dataType?.toUpperCase() ?? "";
  if (hint.includes("JSON")) return "json";
  if (hint.includes("TEXT") || hint.includes("BLOB")) return "text";
  if (hint.includes("SQL")) return "sql";

  const trimmed = content.trim();

  if (
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    (trimmed.endsWith("}") || trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // fall through
    }
  }

  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|CALL|SET)\s/i.test(trimmed)) {
    return "sql";
  }

  if (/^#+\s|^\*\*|^-\s|^\d+\.|^\[.+\]\(/.test(trimmed)) {
    return "markdown";
  }

  return "text";
}

function formatDisplayContent(content: string, type: ContentType): string {
  if (type === "json") {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }

  if (type === "sql") {
    try {
      return format(content, {
        language: "mysql",
        keywordCase: "upper",
        indentStyle: "standard",
      });
    } catch {
      return content;
    }
  }

  return content;
}

function getLanguage(type: ContentType): string {
  if (type === "json") return "json";
  if (type === "sql") return "sql";
  if (type === "markdown") return "markdown";
  return "plaintext";
}

export function CellViewerModal({
  isOpen,
  columnName = "Cell",
  content,
  dataType,
  onClose,
}: Props) {
  const theme = useThemeStore((s) => s.effectiveTheme);
  const [copied, setCopied] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);

  const isNullValue = content === null;
  const displayContent = isNullValue ? "NULL" : String(content);
  const contentType = useMemo(
    () => detectContentType(displayContent, dataType),
    [displayContent, dataType],
  );
  const formattedContent = useMemo(
    () =>
      isNullValue
        ? "NULL"
        : formatDisplayContent(displayContent, contentType),
    [displayContent, contentType, isNullValue],
  );
  const language = useMemo(() => getLanguage(contentType), [contentType]);

  useEffect(() => {
    const editor = editorRef.current;
    const decorations = decorationsRef.current;
    if (!editor || !decorations) return;

    const model = editor.getModel();
    if (!model || !searchTerm || formattedContent.length > 100000) {
      decorations.set([]);
      return;
    }

    const matches = model.findMatches(searchTerm, false, false, false, null, false);
    decorations.set(
      matches.map((match) => ({
        range: match.range,
        options: {
          inlineClassName: "cell-viewer-search-hit",
        },
      })),
    );
  }, [searchTerm, formattedContent]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(formattedContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([formattedContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${columnName}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getTypeLabel = () => {
    if (dataType) {
      const upper = dataType.toUpperCase();
      if (upper.includes("JSON")) return "JSON";
      if (upper.includes("TEXT")) return "TEXT";
      if (upper.includes("BLOB")) return "BLOB";
      if (upper.includes("SQL")) return "SQL";
    }
    return contentType.toUpperCase();
  };

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    decorationsRef.current = editor.createDecorationsCollection();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60">
      <div className="flex max-h-[80vh] w-[780px] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                {columnName}
              </h3>
              <span className="rounded bg-brand-600/20 px-2 py-0.5 text-[10px] font-medium text-brand-400">
                {getTypeLabel()}
              </span>
            </div>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              {isNullValue
                ? "NULL value"
                : `${displayContent.length} characters`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!isNullValue && displayContent.length > 500 && (
          <div className="border-b border-[var(--color-border)] px-4 py-2">
            <input
              type="text"
              placeholder="Search content..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
            />
          </div>
        )}

        <div className="min-h-0 flex-1 p-4">
          <div className="h-full overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)]">
            {isNullValue ? (
              <div className="p-3 text-xs font-mono italic text-[var(--color-text-muted)]">
                NULL
              </div>
            ) : (
              <Editor
                height="100%"
                language={language}
                value={formattedContent}
                onMount={onMount}
                theme={theme === "dark" ? "vs-dark" : "vs"}
                options={{
                  readOnly: true,
                  domReadOnly: true,
                  minimap: { enabled: false },
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  renderWhitespace: "selection",
                  folding: true,
                  fontSize: 12,
                  automaticLayout: true,
                  padding: { top: 8, bottom: 8 },
                  smoothScrolling: true,
                  renderLineHighlightOnlyWhenFocus: true,
                }}
              />
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] p-3">
          <button
            onClick={handleDownload}
            disabled={isNullValue}
            className="inline-flex items-center gap-2 rounded px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-2 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </>
            )}
          </button>
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
