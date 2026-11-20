import { useCallback, useEffect, useRef, useState } from "react";
import { NO_SELECTION, selectAll, type Selection, selectRow, stepSelection } from "../lib/grid-selection";
import type { RowSource } from "../lib/row-source";

/**
 * Which rows are picked, and the two ways of picking them.
 *
 * Split out of ResultsGrid (#406). The transitions themselves live in
 * lib/grid-selection; this is where they meet the mouse, the keyboard, and the
 * fact that a selection stops meaning anything when the rows change.
 *
 * A Shift range and a keyboard step follow the rows as they are on screen
 * (#839, #852), which only the row source knows, and which it may have to
 * fetch. So both ask it, and both are queued: a second key pressed before the
 * first has its answer steps on from where the first lands.
 */

export interface RowSelection {
  selection: Selection;
  /**
   * Click a row: plain picks it, Ctrl adds, Shift extends (FR-3.3.1).
   * `rowIdx` is the row's index in the result. Shift extends over what the
   * user sees, which is the view's order rather than the result's (#839).
   */
  clickRow: (e: React.MouseEvent, rowIdx: number) => void;
  clear: () => void;
  /** Move or extend from the keyboard, through the view (#852). Resolves to the row moved to. */
  step: (delta: number, extend: boolean) => Promise<number | undefined>;
}

export function useRowSelection(
  /** The rows being selected from: their count, and their order on screen. */
  source: RowSource,
  /** Changing it clears the selection: row 4 of the old result is not row 4 of the new one. */
  resetKey: string | null,
  /** The grid's root, so Ctrl+A only fires while the grid is what is being used. */
  gridRef: React.RefObject<HTMLElement | null>,
): RowSelection {
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  // The selection as of the last change, readable between renders: a queued
  // step must start from what the one before it chose.
  const latest = useRef(selection);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const apply = useCallback((next: Selection) => {
    latest.current = next;
    setSelection(next);
  }, []);

  /** Run `task` after whatever is already waiting on the source. */
  const enqueue = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(task);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  useEffect(() => apply(NO_SELECTION), [resetKey, apply]);

  const { rowCount } = source;

  // FR-3.3.1. Scoped to the focused grid on purpose: a Ctrl+A meant for the
  // editor must not quietly select four thousand rows behind it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "a") return;
      if (!gridRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      apply(selectAll(rowCount));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [rowCount, gridRef, apply]);

  const clickRow = useCallback((e: React.MouseEvent, rowIdx: number) => {
    const modifiers = { toggle: e.ctrlKey || e.metaKey, extend: e.shiftKey };
    if (!modifiers.extend || latest.current.anchor === null) {
      apply(selectRow(latest.current, rowIdx, modifiers));
      return;
    }
    void enqueue(async () => {
      const current = latest.current;
      if (current.anchor === null) {
        apply(selectRow(current, rowIdx, modifiers));
        return;
      }
      // The rows between the anchor and the click as they are on screen. A
      // row the filters hide has no place there, and the range falls back to
      // the result's own order.
      let between: number[] | undefined;
      try {
        const [from, to] = await Promise.all([source.positionOf(current.anchor), source.positionOf(rowIdx)]);
        if (from !== null && to !== null) {
          between = await source.indicesAt(Math.min(from, to), Math.max(from, to) + 1);
        }
      } catch {
        // Without the view's order the range is the result's.
      }
      apply(selectRow(latest.current, rowIdx, modifiers, between));
    });
  }, [source, apply, enqueue]);

  const clear = useCallback(() => apply(NO_SELECTION), [apply]);

  const step = useCallback((delta: number, extend: boolean) =>
    enqueue(async () => {
      const current = latest.current;
      const count = source.getSnapshot().viewCount;
      if (count === 0) return undefined;

      // Where the step starts and ends, as positions in the view; then only
      // the stretch of the view the step touches is asked for.
      const from = current.cursor ?? current.anchor;
      const fromPos = from === null || from === undefined ? null : await source.positionOf(from);
      const target = fromPos === null
        ? (delta === Infinity || (delta < 0 && delta !== -Infinity) ? count - 1 : 0)
        : Math.max(0, Math.min(count - 1, fromPos + delta));
      const anchorPos = extend && current.anchor !== null ? await source.positionOf(current.anchor) : null;
      const lo = Math.min(target, anchorPos ?? target, fromPos ?? target);
      const hi = Math.max(target, anchorPos ?? target, fromPos ?? target);
      const stretch = await source.indicesAt(lo, hi + 1);

      const next = stepSelection(current, fromPos === null ? delta : target - fromPos, extend, stretch);
      apply(next);
      return next.cursor;
    }), [source, apply, enqueue]);

  return { selection, clickRow, clear, step };
}
