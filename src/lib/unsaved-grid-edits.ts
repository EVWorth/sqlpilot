/**
 * How many unsaved grid edits each editor tab holds (#865).
 *
 * The edits themselves are the grid's component state, keyed by row index in
 * the result on screen. A run in the same tab replaces that result, and the
 * grid then drops the edits rather than save them against other rows. The
 * run is started from the store, which cannot see the grid's state, so the
 * grid reports its count here and the store asks before discarding it.
 */

const counts = new Map<string, number>();

/** Record what the grid for `tab` has pending; zero forgets the tab. */
export function noteGridEdits(tab: string, count: number) {
  if (count > 0) counts.set(tab, count);
  else counts.delete(tab);
}

/** How many unsaved grid edits `tab` holds. */
export function gridEditsIn(tab: string): number {
  return counts.get(tab) ?? 0;
}

/** Drop the counts of tabs that have closed. */
export function forgetGridEdits(liveTabIds: readonly string[]) {
  const live = new Set(liveTabIds);
  for (const tab of [...counts.keys()]) {
    if (!live.has(tab)) counts.delete(tab);
  }
}

/** For tests: forget every tab. */
export function resetGridEdits() {
  counts.clear();
}
