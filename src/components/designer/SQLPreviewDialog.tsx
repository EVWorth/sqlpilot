import { useRef, useEffect, useCallback } from "react";
import { X, Copy, Play, Check } from "lucide-react";
import { useState } from "react";

interface SQLPreviewDialogProps {
  sql: string;
  onClose: () => void;
  onExecute: () => void;
}

export function SQLPreviewDialog({ sql, onClose, onExecute }: SQLPreviewDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h3 className="text-sm font-medium text-[var(--color-text-primary)]">
            SQL Preview
          </h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <pre className="whitespace-pre-wrap rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 font-mono text-xs leading-relaxed text-[var(--color-text-primary)]">
            {sql}
          </pre>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={() => {
              onExecute();
              onClose();
            }}
            className="flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500"
          >
            <Play className="h-3.5 w-3.5" />
            Execute
          </button>
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
