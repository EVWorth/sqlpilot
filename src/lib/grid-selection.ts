/**
 * Which rows are selected, and what each modifier does to that.
 *
 * FR-3.3.1. There was no selection at all — copying meant right-clicking one
 * row, and "copy these four rows" had no expression (#416).
 *
 * The transitions are the ones every list in every operating system uses, and
 * they are here rather than inline because the anchor is the part people get
 * wrong: Shift+click extends from where the last plain click landed, not from
 * the nearest selected row, so shift-clicking twice in a row replaces the
 * range rather than growing it.
 */

export interface Selection {
  /** Row indices, in the result's own order. */
  rows: ReadonlySet<number>;
  /** Where a Shift range starts, or null when there is nothing to extend from. */
  anchor: number | null;
}

export const NO_SELECTION: Selection = { rows: new Set(), anchor: null };

export interface ClickModifiers {
  /** Ctrl on Windows and Linux, Cmd on macOS — both reach here as `toggle`. */
  toggle: boolean;
  extend: boolean;
}

export function selectRow(
  current: Selection,
  index: number,
  { toggle, extend }: ClickModifiers,
): Selection {
  if (extend && current.anchor !== null) {
    const [from, to] = current.anchor <= index
      ? [current.anchor, index]
      : [index, current.anchor];
    const rows = new Set<number>();
    // Ctrl+Shift extends without discarding what was already picked, which is
    // how you select two separate ranges.
    if (toggle) { for (const r of current.rows) rows.add(r); }
    for (let i = from; i <= to; i++) rows.add(i);
    // The anchor stays put, so dragging the shift-click about resizes one
    // range instead of leaving a trail of them.
    return { rows, anchor: current.anchor };
  }

  if (toggle) {
    const rows = new Set(current.rows);
    if (rows.has(index)) rows.delete(index);
    else rows.add(index);
    // A toggled row becomes the anchor even when it was just removed: the
    // next Shift+click should extend from where the user last pointed.
    return { rows, anchor: index };
  }

  // A plain click on the only selected row clears it, which is how you get
  // back to no selection without reaching for a menu.
  if (current.rows.size === 1 && current.rows.has(index)) return NO_SELECTION;

  return { rows: new Set([index]), anchor: index };
}

/** Ctrl+A. */
export function selectAll(rowCount: number): Selection {
  return { rows: new Set(Array.from({ length: rowCount }, (_, i) => i)), anchor: 0 };
}

/**
 * The rows a copy should act on.
 *
 * An empty selection means the whole result, because "copy" with nothing
 * picked has always meant everything, and making the user select 4000 rows
 * first would be worse than the old behaviour.
 */
export function rowsToCopy(selection: Selection, rowCount: number): number[] {
  if (selection.rows.size === 0) return Array.from({ length: rowCount }, (_, i) => i);
  return [...selection.rows].sort((a, b) => a - b);
}

/** How to describe what a copy would take, for a menu label. */
export function describeSelection(selection: Selection, rowCount: number): string {
  const n = selection.rows.size === 0 ? rowCount : selection.rows.size;
  return `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;
}
