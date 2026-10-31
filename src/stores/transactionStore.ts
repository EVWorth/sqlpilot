import { create } from "zustand";
import type { EditorTab } from "../types";

/**
 * Which transactions are open, for the indicator and the prompts that guard
 * them (#843, #935).
 *
 * Two kinds, because the backends keep transactions in different places:
 *
 * - A MySQL tab's statements run on a session of its own (#731), so a BEGIN
 *   in one tab stays open there until it commits, rolls back, or the session
 *   ends — and ending it, by closing the tab or pointing it at another
 *   server, rolls the work back. Those are kept per tab, in `open`.
 * - A SQLite file has one connection, shared by every tab on it, so a BEGIN
 *   in one tab is open in all of them. Those are kept per connection, in
 *   `openConnections`, and show on every tab bound to that connection.
 */
interface TransactionState {
  /** Tab id → true while its session is inside a transaction. */
  open: Record<string, true>;
  /** Shared (SQLite) connection id → true while it is inside a transaction. */
  openConnections: Record<string, true>;
  setOpen: (tabId: string, open: boolean) => void;
  /** Forget tabs whose sessions are gone. */
  forget: (tabIds: readonly string[]) => void;
  setConnectionOpen: (connectionId: string, open: boolean) => void;
  /** Forget a shared connection that has closed, taking its transaction with it. */
  forgetConnection: (connectionId: string) => void;
}

/** Set or clear `key` in a flag record, returning the same record when nothing changes. */
function withFlag(current: Record<string, true>, key: string, open: boolean): Record<string, true> {
  if (Boolean(current[key]) === open) return current;
  const next = { ...current };
  if (open) next[key] = true;
  else delete next[key];
  return next;
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  open: {},
  openConnections: {},
  setOpen: (tabId, open) => {
    const next = withFlag(get().open, tabId, open);
    if (next !== get().open) set({ open: next });
  },
  forget: (tabIds) => {
    const current = get().open;
    if (!tabIds.some((id) => current[id])) return;
    const next = { ...current };
    for (const id of tabIds) delete next[id];
    set({ open: next });
  },
  setConnectionOpen: (connectionId, open) => {
    const next = withFlag(get().openConnections, connectionId, open);
    if (next !== get().openConnections) set({ openConnections: next });
  },
  forgetConnection: (connectionId) => get().setConnectionOpen(connectionId, false),
}));

/** The flags a tab's state is read from; a store snapshot will do. */
export type TransactionFlags = Pick<TransactionState, "open" | "openConnections">;

/**
 * Whether a transaction is open where this tab runs: on its own session, or
 * on the shared connection it is bound to (#935). A pure read of `flags`, so
 * a component can use it inside a store selector.
 */
export function tabTransactionOpen(flags: TransactionFlags, tab: Pick<EditorTab, "id" | "connectionId">): boolean {
  if (flags.open[tab.id]) return true;
  return tab.connectionId !== undefined && Boolean(flags.openConnections[tab.connectionId]);
}

/** True while this tab's own session holds an open transaction. */
export function hasOpenTransaction(tabId: string): boolean {
  return Boolean(useTransactionStore.getState().open[tabId]);
}

/**
 * True while a transaction is open on this tab's session or on the shared
 * connection it is bound to (#935).
 *
 * Takes the tab rather than its id: which connection a tab is bound to is
 * the editor store's, and reading it from here would make the two stores
 * import each other.
 */
export function hasOpenTransactionForTab(tab: Pick<EditorTab, "id" | "connectionId">): boolean {
  return tabTransactionOpen(useTransactionStore.getState(), tab);
}
