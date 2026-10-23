import type { SortingState } from "@tanstack/react-table";
import { useEffect, useRef } from "react";
import type { EditingDraft } from "../hooks/useGridEditing";

/**
 * What a results grid keeps of itself while its tab is not shown (#842).
 *
 * The grid is remounted per editor tab, so one tab's pending edits are never
 * saved against another tab's rows. Remounting alone dropped unsaved edits,
 * Edit Mode, the sort and the column widths on every tab switch; they are
 * parked here on unmount and handed back when the same tab mounts its grid
 * again.
 */
export interface GridMemorySlots {
  editing: EditingDraft;
  sorting: SortingState;
  columnSizing: Record<string, number>;
}

/** Which tab's grid this is, and the results it was made on. */
export interface GridMemoryScope {
  tab: string;
  /**
   * The tab's results array when the state was kept. A tab whose results
   * changed while it was hidden — a run finished, a refresh landed — gets
   * nothing back: edits are by row index and would land on other rows.
   */
  owner: unknown;
}

interface Entry {
  owner: unknown;
  slots: Partial<GridMemorySlots>;
}

const memory = new Map<string, Entry>();

/** What this tab's grid kept of `slot`, if it was kept on these results. */
export function recallGrid<K extends keyof GridMemorySlots>(
  scope: GridMemoryScope | null,
  slot: K,
): GridMemorySlots[K] | undefined {
  if (!scope) return undefined;
  const entry = memory.get(scope.tab);
  if (!entry || entry.owner !== scope.owner) return undefined;
  return entry.slots[slot];
}

/** Keep `value` for this tab's grid; undefined forgets the slot. */
export function keepGrid<K extends keyof GridMemorySlots>(
  scope: GridMemoryScope | null,
  slot: K,
  value: GridMemorySlots[K] | undefined,
) {
  if (!scope) return;
  let entry = memory.get(scope.tab);
  if (!entry || entry.owner !== scope.owner) {
    entry = { owner: scope.owner, slots: {} };
    memory.set(scope.tab, entry);
  }
  if (value === undefined) delete entry.slots[slot];
  else entry.slots[slot] = value;
}

/** Drop what closed tabs' grids kept. */
export function forgetGridMemory(liveTabIds: readonly string[]) {
  const live = new Set(liveTabIds);
  for (const tab of [...memory.keys()]) {
    if (!live.has(tab)) memory.delete(tab);
  }
}

/** Keep `value` for the grid's tab when the grid unmounts. */
export function useKeepGridOnUnmount<K extends keyof GridMemorySlots>(
  scope: GridMemoryScope | null,
  slot: K,
  value: GridMemorySlots[K] | undefined,
) {
  const latest = useRef({ scope, value });
  useEffect(() => {
    latest.current = { scope, value };
  });
  useEffect(() => {
    const box = latest;
    return () => keepGrid(box.current.scope, slot, box.current.value);
  }, [slot]);
}
