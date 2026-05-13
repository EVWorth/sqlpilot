import { useState, useMemo } from "react";
import { Copy, Check, X, Download } from "lucide-react";

interface Props {
  isOpen: boolean;
  columnName?: string;
  content: string | null;
  dataType?: string;
  onClose: () => void;
}

function detectContentType(content: string): 'json' | 'sql' | 'markdown' | 'text' {
  const trimmed = content.trim();
  
  // Detect JSON
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && 
      (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Not valid JSON, continue
    }
  }
  
  // Detect SQL
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\s/i.test(trimmed)) {
    return 'sql';
  }
  
  // Detect Markdown
  if (/^#+\s|^\*\*|^-\s|^\d+\.|^\[.+\]\(/.test(trimmed)) {
    return 'markdown';
  }
  
  return 'text';
}

function formatJson(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

export function CellViewerModal({
  isOpen,
  columnName = "Cell",
  content,
  dataType,
  onClose,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  if (!isOpen) return null;

  const displayContent = content === null ? "NULL" : String(content);
  const contentType = useMemo(() => detectContentType(displayContent), [displayContent]);
  
  // Format JSON for better readability
  const formattedContent = useMemo(() => {
    if (contentType === 'json') {
      return formatJson(displayContent);
    }
    return displayContent;
  }, [displayContent, contentType]);

  // Highlight search term
  const highlightedContent = useMemo(() => {
    if (!searchTerm || formattedContent.length > 100000) {
      return formattedContent;
    }
    
    const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return formattedContent.replace(regex, '<mark>$1</mark>');
  }, [formattedContent, searchTerm]);

  const handleCopy = () => {
    navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([displayContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${columnName}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const getTypeLabel = () => {
    if (dataType) {
      if (dataType.toUpperCase().includes('JSON')) return 'JSON';
      if (dataType.toUpperCase().includes('TEXT')) return 'TEXT';
      if (dataType.toUpperCase().includes('BLOB')) return 'BLOB';
    }
    return contentType.toUpperCase();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60">
      <div className="max-h-[80vh] w-[700px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                {columnName}
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded bg-brand-600/20 text-brand-400 font-medium">
                {getTypeLabel()}
              </span>
            </div>
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">
              {displayContent === "NULL" ? "NULL value" : `${displayContent.length} characters`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search Bar (only show for large content) */}
        {displayContent.length > 500 && (
          <div className="border-b border-[var(--color-border)] px-4 py-2">
            <input
              type="text"
              placeholder="Search content..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] outline-none placeholder-[var(--color-text-muted)]"
            />
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <div className="rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)] p-3">
            {displayContent === "NULL" ? (
              <pre className="text-xs font-mono text-[var(--color-text-muted)] italic">
                NULL
              </pre>
            ) : (
              <pre className="text-xs font-mono text-[var(--color-text-primary)] whitespace-pre-wrap break-words">
                <code
                  dangerouslySetInnerHTML={{
                    __html: highlightedContent,
                  }}
                />
              </pre>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] p-3">
          <button
            onClick={handleDownload}
            disabled={displayContent === "NULL"}
            className="inline-flex items-center gap-2 rounded px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-2 rounded px-3 py-1.5 text-xs font-medium bg-brand-600 text-white hover:bg-brand-700 transition-colors"
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
            className="rounded px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
