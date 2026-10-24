import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

/**
 * A folder in the schema tree.
 *
 * Carries the ARIA a tree needs: without `role="treeitem"` and
 * `aria-expanded`, a screen reader announces a list of unrelated buttons and
 * gives no way to tell an open folder from a closed one (F3.11 of #299).
 *
 * The role is on the button, which is what takes focus, so the row that is
 * focused is the one announced as a tree item (#823). Its children follow
 * in a group, and `aria-level` says how deep it sits.
 */

interface FolderNodeProps {
  label: string;
  icon: React.ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  count?: number;
  loading?: boolean;
  /** Depth in the tree, from 1. Folders sit under a database. */
  level?: number;
  /** The roving-tabindex props from `useTreeNavigation`. */
  rowProps?: { "data-tree-key": string; tabIndex: number };
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
  level = 2,
  rowProps,
  children,
}: FolderNodeProps) {
  return (
    <div role="none">
      <button
        role="treeitem"
        aria-expanded={isExpanded}
        aria-level={level}
        aria-label={label}
        {...rowProps}
        onClick={onToggle}
        onContextMenu={onContextMenu}
        // Left and Right are what a tree responds to, and they are cheap to
        // support on the node that already has focus.
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" && !isExpanded) {
            e.preventDefault();
            onToggle();
          } else if (e.key === "ArrowLeft" && isExpanded) {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      >
        {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        {icon}
        <span>{label}</span>
        {count != null && (
          <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
            {count}
          </span>
        )}
      </button>
      {isExpanded && (
        <div role="group" className="ml-3">
          {loading
            ? (
              <div
                role="none"
                className="flex items-center gap-2 px-1.5 py-1 text-[11px] text-[var(--color-text-muted)]"
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading...
              </div>
            )
            : children}
        </div>
      )}
    </div>
  );
}
