import { Filter, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type ColumnFilter,
  defaultOperator,
  type FilterOperator,
  isActiveFilter,
  NULLARY_OPERATORS,
  OPERATOR_LABEL,
  operatorsFor,
} from "../../lib/grid-filter";

/**
 * The filter control on one column header.
 *
 * FR-3.1.3. The operator comes first and the operand second, because the
 * operand's shape depends on it — `between` needs two, `is NULL` needs none —
 * and a single text box cannot express any of that (#391).
 *
 * Changes apply as they are typed. A filter over rows already in memory is
 * cheap enough that making the user press a button would only add a step.
 */

export interface ColumnFilterMenuProps {
  column: string;
  dataType: string | undefined;
  filter: ColumnFilter | undefined;
  onChange: (filter: ColumnFilter | undefined) => void;
}

export function ColumnFilterMenu({ column, dataType, filter, onChange }: ColumnFilterMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const active = isActiveFilter(filter);

  const current: ColumnFilter = filter ?? { operator: defaultOperator(dataType), value: "" };
  const takesOperand = !NULLARY_OPERATORS.has(current.operator);
  const takesRange = current.operator === "between";

  useEffect(() => {
    if (!open) return;
    const onDocumentPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const field =
    "h-6 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 text-[11px] text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        // The header above owns click-to-sort, so every event here stops
        // there: opening a filter must not also re-sort the column.
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
        draggable={false}
        aria-label={`Filter ${column}`}
        aria-expanded={open}
        className={`shrink-0 rounded p-0.5 transition-opacity hover:bg-[var(--color-bg-primary)] ${
          active
            ? "text-brand-400 opacity-100"
            : "text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 focus:opacity-100"
        }`}
      >
        <Filter className="h-3 w-3" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`Filter ${column}`}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-30 mt-1 w-56 space-y-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 text-left font-normal shadow-xl"
        >
          <select
            value={current.operator}
            aria-label={`Filter ${column} by`}
            // A nullary operator narrows the moment it is chosen; the others
            // wait for an operand, which isActiveFilter decides downstream.
            onChange={(e) => onChange({ ...current, operator: e.target.value as FilterOperator })}
            className={`${field} px-0.5`}
          >
            {operatorsFor(dataType).map((op) => <option key={op} value={op}>{OPERATOR_LABEL[op]}</option>)}
          </select>

          {takesOperand && (
            <div className="flex items-center gap-1">
              <input
                type="text"
                autoFocus
                value={current.value}
                aria-label={takesRange ? `Filter ${column} from` : `Filter ${column} value`}
                placeholder={takesRange ? "from" : "value"}
                onChange={(e) => onChange({ ...current, value: e.target.value })}
                className={field}
              />
              {takesRange && (
                <input
                  type="text"
                  value={current.value2 ?? ""}
                  aria-label={`Filter ${column} to`}
                  placeholder="to"
                  onChange={(e) => onChange({ ...current, value2: e.target.value })}
                  className={field}
                />
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
            disabled={!active}
            className="flex w-full items-center justify-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
          >
            <X className="h-3 w-3" />
            Clear filter
          </button>
        </div>
      )}
    </div>
  );
}
