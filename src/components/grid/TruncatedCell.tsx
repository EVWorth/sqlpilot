import { Check, Copy, Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { describeBlob, detectMime, formatBytes, isBytes, toHex } from "../../lib/blob";
import { isLongTextSqlType } from "../../lib/sql-types";

interface Props {
  value: unknown;
  columnName: string;
  dataType?: string;
  /** `bytes` is set only for a binary column, whose value is not text (#401). */
  onViewFull: (content: string | null, columnName: string, bytes?: number[]) => void;
  /**
   * Set when `value` is only the start of what is stored: the full length in
   * bytes. The cell says so, and the viewer and Copy take the whole value
   * from `loadFull` rather than the part painted here.
   */
  fullLen?: number | null;
  /** The whole value, for a cell that was cut short. */
  loadFull?: () => Promise<unknown>;
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
  // A BLOB arrives as an array of bytes, and String() on it prints every one
  // of them, comma-separated. `137,80,78,71,…` is not a preview of a PNG; the
  // type and the size are (#401).
  if (isBytes(val)) return `[${describeBlob(val)}]`;
  if (typeof val === "string") return val;
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  return String(val);
}

/** A value that was cut short: its start, marked as such, or the real size of a BLOB. */
function formatCut(val: unknown, fullLen: number): string {
  if (isBytes(val)) return `[${detectMime(val) ?? "BLOB"}, ${formatBytes(fullLen)}]`;
  return `${formatValue(val)}…`;
}

export function TruncatedCell({
  value,
  columnName,
  dataType,
  onViewFull,
  fullLen = null,
  loadFull,
}: Props) {
  const whole = fullLen === null ? undefined : loadFull;
  const formatted = whole && fullLen !== null ? formatCut(value, fullLen) : formatValue(value);
  const isNull = isNullish(value);
  const binary = isBytes(value) ? value : null;
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

  // Always offered for bytes: there is nothing useful in the cell itself, so
  // the viewer is the only way to see what is stored.
  // And for a cut value, which is longer than the cell whatever its width.
  const showIcon = showForTextType || isOverflowing || binary !== null || whole !== undefined;
  const showValue = (full: unknown) => {
    if (isBytes(full)) onViewFull(null, columnName, full);
    else onViewFull(isNullish(full) ? null : formatValue(full), columnName);
  };
  const openViewer = () => {
    if (whole) {
      // The viewer opens on the whole value or not at all; whoever supplied
      // `loadFull` reports a failure.
      void whole().then(showValue, () => {});
      return;
    }
    if (binary) {
      onViewFull(null, columnName, binary);
      return;
    }
    onViewFull(value === null || value === undefined ? null : formatted, columnName);
  };

  // Copy sits beside the expand button, so a long value — a SHOW CREATE TABLE
  // statement, say — can be taken without opening the viewer first (#739).
  // It copies the stored text as-is, not the viewer's reformatted version;
  // bytes go as hex, the same as the viewer's Copy.
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);
  const copyValue = () => {
    const write = (text: string) =>
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1500);
      });
    if (whole) {
      void whole().then((full) => write(isBytes(full) ? toHex(full) : formatValue(full))).catch(() => {});
      return;
    }
    void write(binary ? toHex(binary) : formatted).catch(() => {});
  };

  const iconButton =
    "shrink-0 rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] focus-visible:opacity-100 group-hover:opacity-100";

  return (
    <div className="group flex min-w-0 items-center gap-1">
      <div
        ref={textRef}
        className={`min-w-0 truncate ${isNull ? "italic text-[var(--color-text-muted)]" : ""}`}
        onDoubleClick={showIcon ? openViewer : undefined}
        title={showForTextType || binary ? "View full content" : undefined}
      >
        {formatted}
      </div>
      {showIcon && !isNull && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            copyValue();
          }}
          className={copied ? iconButton.replace("opacity-0", "opacity-100") : iconButton}
          title={copied ? "Copied" : "Copy value"}
          aria-label={copied ? "Copied" : "Copy value"}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      )}
      {showIcon && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openViewer();
          }}
          className={iconButton}
          title="View full content"
          aria-label="View full content"
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
