import { useEffect, useRef, useState } from "react";
import { FOCUS_ROW_LIMIT_EVENT } from "../../lib/truncation";

export const MIN_ROW_LIMIT = 1;
export const MAX_ROW_LIMIT = 100_000;

interface RowLimitInputProps {
  value: number;
  onChange: (value: number) => void;
}

/** A whole number in range, or null when the draft is not one. */
function parseLimit(draft: string): number | null {
  if (!/^\s*\d+\s*$/.test(draft)) return null;
  const n = parseInt(draft, 10);
  return n >= MIN_ROW_LIMIT && n <= MAX_ROW_LIMIT ? n : null;
}

/**
 * The toolbar's LIMIT box.
 *
 * Typing edits a local draft, which is only checked and stored on blur or
 * Enter. Validating every keystroke refused each intermediate value: the box
 * could not be emptied, and typing a new number appended to the old one
 * (#848). An out-of-range number is clamped, anything else reverts, and
 * Escape puts the stored value back.
 */
export function RowLimitInput({ value, onChange }: RowLimitInputProps) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  // Set by Escape, so the blur that follows does not store the draft it
  // just discarded.
  const discard = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  // The truncation banner's "Change LIMIT" lands here (#853).
  useEffect(() => {
    const focus = () => {
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener(FOCUS_ROW_LIMIT_EVENT, focus);
    return () => window.removeEventListener(FOCUS_ROW_LIMIT_EVENT, focus);
  }, []);

  // Follow the stored value when it changes elsewhere, but never while the
  // user is typing over it.
  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  const invalid = parseLimit(draft) === null;
  const rangeText = `Allowed range: ${MIN_ROW_LIMIT.toLocaleString("en-US")}–${MAX_ROW_LIMIT.toLocaleString("en-US")}`;

  const commit = () => {
    // Only a whole number is clamped. `type="number"` also accepts `1e3` and
    // `2.5`, which parseInt would read as 1 and 2; those revert instead.
    let next = value;
    if (/^\s*-?\d+\s*$/.test(draft)) {
      next = Math.min(MAX_ROW_LIMIT, Math.max(MIN_ROW_LIMIT, parseInt(draft, 10)));
    }
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <span className="relative flex items-center">
      <input
        ref={input}
        type="number"
        aria-label="Row limit"
        aria-invalid={invalid}
        title={invalid ? `${rangeText}. Out-of-range values are clamped on Enter.` : rangeText}
        value={draft}
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (discard.current) setDraft(String(value));
          else commit();
          discard.current = false;
          setFocused(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
          } else if (e.key === "Escape") {
            discard.current = true;
            e.currentTarget.blur();
          }
        }}
        min={MIN_ROW_LIMIT}
        max={MAX_ROW_LIMIT}
        className={`min-h-6 w-16 rounded border bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-xs text-[var(--color-text-primary)] focus:outline-none focus:ring-1 ${
          invalid
            ? "border-[var(--color-error)] focus:ring-[var(--color-error)]"
            : "border-[var(--color-border)] focus:ring-[var(--color-accent)]"
        }`}
      />
      {focused && invalid && (
        <span
          role="alert"
          className="absolute left-0 top-full z-20 mt-1 whitespace-nowrap rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--color-error)] shadow"
        >
          {rangeText}
        </span>
      )}
    </span>
  );
}
