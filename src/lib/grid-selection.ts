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
  /**
   * The row the keyboard last moved to, when it differs from the anchor:
   * Shift+Arrow grows the range from the anchor to here (#852).
   */
  cursor?: number;
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
  /**
   * Result indices in the order they are on screen. A Shift range covers
   * what lies between the two rows *on screen*, which after a sort or filter
   * is not the run of result indices between them (#839). Omitted, the
   * screen is taken to be in result order.
   */
  order?: readonly number[],
): Selection {
  if (extend && current.anchor !== null) {
    const rows = new Set<number>();
    // Ctrl+Shift extends without discarding what was already picked, which is
    // how you select two separate ranges.
    if (toggle) { for (const r of current.rows) rows.add(r); }
    const anchorPos = order ? order.indexOf(current.anchor) : -1;
    const indexPos = order ? order.indexOf(index) : -1;
    if (order && anchorPos >= 0 && indexPos >= 0) {
      const [from, to] = anchorPos <= indexPos ? [anchorPos, indexPos] : [indexPos, anchorPos];
      for (let i = from; i <= to; i++) rows.add(order[i]);
    } else {
      const [from, to] = current.anchor <= index
        ? [current.anchor, index]
        : [index, current.anchor];
      for (let i = from; i <= to; i++) rows.add(i);
    }
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
export function rowsToCopy(
  selection: Selection,
  rowCount: number,
  /**
   * Result indices in the order they are on screen. Selected rows are copied
   * in that order, so a copy from a sorted grid reads as the grid does
   * (#858). Rows not on screen (filtered out) follow in result order.
   */
  order?: readonly number[],
): number[] {
  if (selection.rows.size === 0) return Array.from({ length: rowCount }, (_, i) => i);
  const byIndex = [...selection.rows].sort((a, b) => a - b);
  if (!order) return byIndex;
  const onScreen = order.filter((i) => selection.rows.has(i));
  const shown = new Set(onScreen);
  return [...onScreen, ...byIndex.filter((i) => !shown.has(i))];
}

/** How to describe what a copy would take, for a menu label. */
export function describeSelection(selection: Selection, rowCount: number): string {
  const n = selection.rows.size === 0 ? rowCount : selection.rows.size;
  return `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;
}

/**
 * Arrow keys, Home and End (#852).
 *
 * Moves through `order` — result indices as they are on screen — so the
 * keyboard follows a sort the way a Shift+click does. With `extend`, the range
 * runs from the anchor to the new row; without, the new row alone is picked.
 * `delta` is clamped to the ends, so ±Infinity is Home and End.
 */
export function stepSelection(
  current: Selection,
  delta: number,
  extend: boolean,
  order: readonly number[],
): Selection {
  if (order.length === 0) return current;
  const from = current.cursor ?? current.anchor;
  const pos = from === null || from === undefined ? -1 : order.indexOf(from);
  // From nothing, a step down starts at the top and a step up at the bottom,
  // but Home and End (±Infinity) still go where they say (#852).
  const next = pos < 0
    ? (delta === Infinity || (delta < 0 && delta !== -Infinity) ? order.length - 1 : 0)
    : Math.max(0, Math.min(order.length - 1, pos + delta));
  const target = order[next];
  const anchorPos = current.anchor === null ? -1 : order.indexOf(current.anchor);
  if (extend && anchorPos >= 0) {
    const [lo, hi] = anchorPos <= next ? [anchorPos, next] : [next, anchorPos];
    return { rows: new Set(order.slice(lo, hi + 1)), anchor: current.anchor, cursor: target };
  }
  return { rows: new Set([target]), anchor: target, cursor: target };
}
