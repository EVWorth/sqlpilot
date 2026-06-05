import { ChevronRight, ChevronDown, Loader2 } from "lucide-react";

interface FolderNodeProps {
  label: string;
  icon: React.ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  count?: number;
  loading?: boolean;
  children?: React.ReactNode;
}

export function FolderNode({
  label,
  icon,
  isExpanded,
  onToggle,
  onContextMenu,
  count,
  loading,
  children,
}: FolderNodeProps) {
  return (
    <div>
      <button
        onClick={onToggle}
        onContextMenu={onContextMenu}
        className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {icon}
        <span>{label}</span>
        {count != null && (
          <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
            {count}
          </span>
        )}
      </button>
      {isExpanded && (
        <div className="ml-3">
          {loading ? (
            <div className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-[var(--color-text-muted)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading...
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}
