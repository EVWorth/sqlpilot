import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

/**
 * One column header: sorting, resizing, and dragging to reorder.
 *
 * The grid renders headers twice — once for the virtualized path, once for the
 * plain table — and the two copies had drifted apart before this existed. Any
 * behaviour added to one and not the other is a bug that only appears above
 * 5000 rows, which is where nobody looks (#392, #406).
 *
 * `as` picks the element rather than the behaviour: a table needs `<th>`, the
 * virtualized flex layout needs `<div>`, and everything inside is the same.
 */

export interface GridHeaderCellProps {
  as: "th" | "div";
  columnId: string;
  label: ReactNode;
  /** Position in the sort, 1-based, or 0 when this column is not sorting. */
  sortIndex: number;
  sortDirection: "asc" | "desc" | false;
  /** True when more than one column is sorting, so priority is worth showing. */
  showSortPriority: boolean;
  numeric: boolean;
  canResize: boolean;
  isResizing: boolean;
  style?: CSSProperties;
  className?: string;
  /** Passed the event so Shift can add to the sort rather than replace it. */
  onSort: (event: React.MouseEvent) => void;
  onResizeStart: (event: React.MouseEvent | React.TouchEvent) => void;
  onAutoSize: () => void;
  /** Reorder, or undefined to leave the column fixed. */
  onDropColumn?: (fromColumnId: string) => void;
  isDropTarget: boolean;
  onDragStateChange: (state: { dragging?: string | null; over?: string | null }) => void;
}

const DRAG_MIME = "application/x-sqlpilot-column";

export function GridHeaderCell({
  as: Tag,
  columnId,
  label,
  sortIndex,
  sortDirection,
  showSortPriority,
  numeric,
  canResize,
  isResizing,
  style,
  className = "",
  onSort,
  onResizeStart,
  onAutoSize,
  onDropColumn,
  isDropTarget,
  onDragStateChange,
}: GridHeaderCellProps) {
  const draggable = Boolean(onDropColumn);

  return (
    <Tag
      key={columnId}
      // Drag has to be declared on the element that owns the pointer, so the
      // resize handle below opts out of it explicitly.
      draggable={draggable}
      onDragStart={(e: React.DragEvent) => {
        if (!draggable) return;
        e.dataTransfer.setData(DRAG_MIME, columnId);
        e.dataTransfer.effectAllowed = "move";
        onDragStateChange({ dragging: columnId });
      }}
      onDragOver={(e: React.DragEvent) => {
        if (!draggable || !e.dataTransfer.types.includes(DRAG_MIME)) return;
        // Without this the drop never fires: the default handling of dragover
        // is to refuse the drop.
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragStateChange({ over: columnId });
      }}
      onDragLeave={() => onDragStateChange({ over: null })}
      onDrop={(e: React.DragEvent) => {
        if (!draggable) return;
        e.preventDefault();
        const from = e.dataTransfer.getData(DRAG_MIME);
        onDragStateChange({ dragging: null, over: null });
        if (from && from !== columnId) onDropColumn?.(from);
      }}
      onDragEnd={() => onDragStateChange({ dragging: null, over: null })}
      onClick={onSort}
      aria-sort={sortDirection === "asc"
        ? "ascending"
        : sortDirection === "desc"
        ? "descending"
        : "none"}
      title={draggable
        ? "Click to sort, Shift+click to add a sort, drag to reorder"
        : "Click to sort, Shift+click to add a sort"}
      className={`relative cursor-pointer select-none border-b border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] ${
        isDropTarget ? "shadow-[inset_2px_0_0_0_var(--color-brand-500,#6366f1)]" : ""
      } ${numeric ? "text-right" : "text-left"} ${className}`}
      style={style}
    >
      <div className={`flex items-center gap-1 ${numeric ? "justify-end" : ""}`}>
        {draggable && (
          <GripVertical
            className="h-3 w-3 shrink-0 text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          />
        )}
        {label}
        {sortDirection === "asc" && <ArrowUp className="h-3 w-3 shrink-0" />}
        {sortDirection === "desc" && <ArrowDown className="h-3 w-3 shrink-0" />}
        {showSortPriority && sortIndex > 0 && (
          // Which key this is. Two arrows with no order tell you the grid is
          // multi-sorting but not which column wins.
          <span
            className="shrink-0 rounded bg-[var(--color-bg-primary)] px-1 text-[9px] leading-[14px] text-[var(--color-text-muted)]"
            aria-label={`Sort priority ${sortIndex}`}
          >
            {sortIndex}
          </span>
        )}
      </div>
      {canResize && (
        <div
          draggable={false}
          // A drag started on the resize handle would reorder the column
          // instead of resizing it.
          onDragStart={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onResizeStart(e);
          }}
          onTouchStart={onResizeStart}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onAutoSize();
          }}
          className={`absolute right-0 top-0 h-full w-1 cursor-col-resize touch-none select-none ${
            isResizing ? "bg-brand-500" : "hover:bg-brand-500/40"
          }`}
          title="Drag to resize column, double-click to fit"
        />
      )}
    </Tag>
  );
}
