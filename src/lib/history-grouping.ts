import type { HistoryEntry } from "./bindings";

/**
 * A history row: one entry, or a run of identical ones collapsed together.
 *
 * Running the same statement ten times while iterating filled ten rows and
 * pushed the rest of the session off the panel. With a 500-entry cap a tight
 * edit-run loop could evict a morning's work (#590).
 */
export interface HistoryGroup {
  /** The most recent run. What the row shows. */
  entry: HistoryEntry;
  /** Every run in the group, newest first. Length 1 for an ordinary row. */
  runs: HistoryEntry[];
}

/**
 * Collapse *consecutive* runs of the same statement on the same connection.
 *
 * Only consecutive ones. Non-adjacent repeats stay separate because the order
 * is the story: `SELECT`, `UPDATE`, `SELECT` is someone checking their work,
 * and merging the two selects would hide that.
 *
 * A failed run never merges into a successful one even when the text matches.
 * The outcome is the most important thing on the row, and a group showing
 * "×5" with a green tick when one of them failed would be a lie.
 */
export function groupConsecutive(entries: HistoryEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = [];

  for (const entry of entries) {
    // `groups.at(-1)` would be neater, but the tsconfig target predates it.
    const last = groups.length > 0 ? groups[groups.length - 1] : undefined;
    if (
      last
      && last.entry.sql === entry.sql
      && last.entry.connectionName === entry.connectionName
      && last.entry.database === entry.database
      && last.entry.status === entry.status
      && last.entry.origin === entry.origin
    ) {
      last.runs.push(entry);
      continue;
    }
    groups.push({ entry, runs: [entry] });
  }

  return groups;
}
