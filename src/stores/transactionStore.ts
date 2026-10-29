import { create } from "zustand";

/**
 * Which editor tabs' server sessions have a transaction open (#843).
 *
 * A tab's statements run on a session of its own (#731), so a BEGIN in one tab
 * stays open there until it commits, rolls back, or the session ends — and
 * ending it, by closing the tab or pointing it at another server, rolls the
 * work back. This is what the indicator and the close prompt read.
 */
interface TransactionState {
  /** Tab id → true while its session is inside a transaction. */
  open: Record<string, true>;
  setOpen: (tabId: string, open: boolean) => void;
  /** Forget tabs whose sessions are gone. */
  forget: (tabIds: readonly string[]) => void;
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  open: {},
  setOpen: (tabId, open) => {
    const current = get().open;
    if (Boolean(current[tabId]) === open) return;
    const next = { ...current };
    if (open) next[tabId] = true;
    else delete next[tabId];
    set({ open: next });
  },
  forget: (tabIds) => {
    const current = get().open;
    if (!tabIds.some((id) => current[id])) return;
    const next = { ...current };
    for (const id of tabIds) delete next[id];
    set({ open: next });
  },
}));

/** True while this tab's session holds an open transaction. */
export function hasOpenTransaction(tabId: string): boolean {
  return Boolean(useTransactionStore.getState().open[tabId]);
}
