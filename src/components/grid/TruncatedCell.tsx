import { Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isLongTextSqlType } from "../../lib/sql-types";

interface Props {
  value: unknown;
  columnName: string;
  dataType?: string;
  onViewFull: (content: string | null, columnName: string) => void;
}

const TEXT_TYPE_MIN_LENGTH = 20;

/**
 * A real NULL and a string containing the text "NULL" formatted identically,
 * so the grid could not tell an absent value from the word. It is now styled
 * distinctly instead — which also means numeric columns can keep one
 * alignment for the whole column rather than letting NULLs break the run of
 * digits.
 */
function isNullish(val: unknown): boolean {
  return val === null || val === undefined;
}

function formatValue(val: unknown): string {
  if (isNullish(val)) return "NULL";
  if (typeof val === "string") return val;
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  return String(val);
}

export function TruncatedCell({
  value,
  columnName,
  dataType,
  onViewFull,
}: Props) {
  const formatted = formatValue(value);
  const isNull = isNullish(value);
  const isTextType = isLongTextSqlType(dataType);
  const showForTextType = isTextType
    && value !== null
    && value !== undefined
    && formatted.length >= TEXT_TYPE_MIN_LENGTH;

  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLDivElement | null>(null);

  // One observer for as long as the cell is mounted.
  //
  // This used to list `formatted` among its dependencies, so every value
  // change tore the observer down and built a new one. A grid polling
  // `SELECT NOW()`, or a column being typed into, does that for every visible
  // cell on every render — hundreds of ResizeObserver constructions a second,
  // all doing the work of one. Nothing leaked, since the cleanup did
  // disconnect them, but the churn is pure waste and it showed up as CPU
  // burnt on an idle grid (#417).
  //
  // `columnName` and `dataType` were dependencies too, and neither has any
  // bearing on whether text overflows its box.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    let scheduled = false;
    const ro = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        setIsOverflowing(el.scrollWidth > el.clientWidth);
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Text can change without the box resizing, and that changes whether it
  // overflows — so the measurement still has to re-run per value. One layout
  // read, which is what the old effect was really for.
  useEffect(() => {
    const el = textRef.current;
    if (el) setIsOverflowing(el.scrollWidth > el.clientWidth);
  }, [formatted]);

  const showIcon = showForTextType || isOverflowing;
  const openViewer = () => {
    onViewFull(value === null || value === undefined ? null : formatted, columnName);
  };

  return (
    <div className="group flex min-w-0 items-center gap-1">
      <div
        ref={textRef}
        className={`min-w-0 truncate ${isNull ? "italic text-[var(--color-text-muted)]" : ""}`}
        onDoubleClick={showIcon ? openViewer : undefined}
        title={showForTextType ? "View full content" : undefined}
      >
        {formatted}
      </div>
      {showIcon && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openViewer();
          }}
          className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
          title="View full content"
          aria-label="View full content"
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
