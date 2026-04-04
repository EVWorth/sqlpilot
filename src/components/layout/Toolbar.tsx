import { Database, Keyboard } from "lucide-react";

interface ToolbarProps {
  onShowShortcuts?: () => void;
}

export function Toolbar({ onShowShortcuts }: ToolbarProps) {
  return (
    <div className="flex h-10 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3">
      <div className="flex items-center gap-2">
        <Database className="h-5 w-5 text-brand-400" />
        <span className="text-sm font-semibold text-[var(--color-text-primary)]">
          MySQL AI Studio
        </span>
      </div>
      <div className="flex-1" />
      <button
        onClick={onShowShortcuts}
        title="Keyboard Shortcuts (F1)"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
      >
        <Keyboard className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
