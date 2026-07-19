import { Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Props {
  value: unknown;
  columnName: string;
  dataType?: string;
  onViewFull: (content: string | null, columnName: string) => void;
}

const TEXT_TYPE_MIN_LENGTH = 20;
const TEXT_TYPE_PATTERN = /text|blob|json|mediumtext|longtext/i;

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "string") return val;
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  return String(val);
}

function isLongTextType(dataType?: string): boolean {
  if (!dataType) return false;
  return TEXT_TYPE_PATTERN.test(dataType);
}

export function TruncatedCell({
  value,
  columnName,
  dataType,
  onViewFull,
}: Props) {
  const formatted = formatValue(value);
  const isTextType = isLongTextType(dataType);
  const showForTextType = isTextType
    && value !== null
    && value !== undefined
    && formatted.length >= TEXT_TYPE_MIN_LENGTH;

  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    let scheduled = false;
    const check = () => setIsOverflowing(el.scrollWidth > el.clientWidth);
    const ro = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        check();
      });
    });
    ro.observe(el);
    check();
    return () => ro.disconnect();
  }, [formatted, columnName, dataType]);

  const showIcon = showForTextType || isOverflowing;
  const openViewer = () => {
    onViewFull(value === null || value === undefined ? null : formatted, columnName);
  };

  return (
    <div className="group flex min-w-0 items-center gap-1">
      <div
        ref={textRef}
        className="min-w-0 truncate"
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
