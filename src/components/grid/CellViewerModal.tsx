import { useState } from "react";
import { Copy, Check, X } from "lucide-react";

interface Props {
  isOpen: boolean;
  columnName?: string;
  content: string | null;
  onClose: () => void;
}

export function CellViewerModal({
  isOpen,
  columnName = "Cell",
  content,
  onClose,
}: Props) {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const displayContent = content === null ? "NULL" : String(content);

  const handleCopy = () => {
    navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60">
      <div className="max-h-[70vh] w-[600px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {columnName}
            </h3>
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">
              {displayContent.length} characters
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <div className="rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)] p-3">
            <pre className="text-xs font-mono text-[var(--color-text-primary)] whitespace-pre-wrap break-words">
              {displayContent}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] p-3">
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
            className="rounded px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
