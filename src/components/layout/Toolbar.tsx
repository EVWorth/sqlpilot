import { Database } from "lucide-react";

export function Toolbar() {
  return (
    <div className="flex h-10 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3">
      <div className="flex items-center gap-2">
        <Database className="h-5 w-5 text-brand-400" />
        <span className="text-sm font-semibold text-[var(--color-text-primary)]">
          MySQL AI Studio
        </span>
      </div>
    </div>
  );
}
