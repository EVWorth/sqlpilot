import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { resultLabel } from "../../lib/result-label";
import type { QueryResult } from "../../types";

/**
 * One tab per result of a script, above whatever the active one shows (#844).
 *
 * Above the placeholder as well as the grid: a statement that returned only a
 * count has no grid, and the strip used to vanish with it, leaving no way back
 * to the script's other results.
 */
export function ResultTabs({
  results,
  activeIndex,
  onSelect,
}: {
  results: readonly QueryResult[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  if (results.length < 2) return null;
  return (
    <div
      role="tablist"
      aria-label="Statement results"
      className="flex shrink-0 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
    >
      {results.map((result, idx) => {
        const label = resultLabel(result, idx);
        const active = idx === activeIndex;
        return (
          <button
            key={idx}
            type="button"
            role="tab"
            aria-selected={active}
            title={result.sql || label}
            onClick={() => onSelect(idx)}
            className={twMerge(
              clsx(
                "shrink-0 whitespace-nowrap px-3 py-1 text-xs",
                active
                  ? "border-b-2 border-brand-500 text-[var(--color-text-primary)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
              ),
            )}
          >
            <span className="text-[var(--color-text-muted)]">{idx + 1}.</span> {label}
          </button>
        );
      })}
    </div>
  );
}
