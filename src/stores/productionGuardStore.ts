import { create } from "zustand";
import { isDestructiveStatement } from "../lib/sql-safety";
import { useConnectionStore } from "./connectionStore";

/**
 * The confirmation a destructive statement raises on a production connection.
 *
 * `resultStore` has had this gate since #393, but only statements routed
 * through `resultStore.executeQuery` ever reached it. Grid cell edits, the
 * admin panel, import and restore all call `api.executeQuery` directly, so
 * editing a cell on a connection marked production wrote to it with no
 * confirmation at all (#588).
 *
 * The reason they went direct is that the store's gate cannot be awaited: it
 * raises a dialog and returns, leaving the caller no way to learn whether the
 * user agreed. A caller that has work to do afterwards — refresh the grid,
 * advance an import loop, close a dialog — cannot use it.
 *
 * This gate answers. `confirmDestructive` resolves true when the user
 * confirms and false when they decline, so a caller reads as ordinary
 * sequential code:
 *
 * ```ts
 * if (!(await confirmDestructive({ connectionId, sql, action: "Save 3 changes" }))) return;
 * ```
 */

export interface GuardRequest {
  title: string;
  message: string;
  confirmLabel: string;
}

interface GuardState {
  pending: GuardRequest | null;
  /** Resolver for the in-flight request. Not for callers. */
  resolve: ((confirmed: boolean) => void) | null;
  ask: (request: GuardRequest) => Promise<boolean>;
  answer: (confirmed: boolean) => void;
}

export const useProductionGuardStore = create<GuardState>((set, get) => ({
  pending: null,
  resolve: null,

  ask: (request) => {
    // A second request while one is open would strand the first caller's
    // promise for ever. Declining it is the safe answer: the user has not
    // agreed to anything, so nothing runs.
    const existing = get().resolve;
    if (existing) existing(false);

    return new Promise<boolean>((resolve) => {
      set({ pending: request, resolve });
    });
  },

  answer: (confirmed) => {
    const resolve = get().resolve;
    set({ pending: null, resolve: null });
    resolve?.(confirmed);
  },
}));

/** Whether this connection's profile is marked as production. */
export function isProductionConnection(connectionId: string): boolean {
  const state = useConnectionStore.getState();
  // Tolerating an absent list rather than throwing: a store read that lands
  // before connections have loaded is the same situation as a connection that
  // is not in the list, and both already answer "not production". Throwing
  // here would abort the caller's save instead of gating it.
  const conn = (state.activeConnections ?? []).find((c) => c.id === connectionId);
  if (!conn) return false;
  const profile = (state.profiles ?? []).find((p) => p.id === conn.profile_id);
  return profile?.environment === "production";
}

export interface ConfirmDestructiveOptions {
  connectionId: string;
  /**
   * The statement, or every statement of a batch.
   *
   * A batch is judged as a whole and confirmed once. Prompting per statement
   * through a thousand-line dump would train the user to hold down Enter,
   * which is worse than not asking.
   */
  sql: string | string[];
  /** What the user is about to do, e.g. "Save 3 changes to `orders`". */
  action: string;
  /** Extra context shown under the action, when there is any worth showing. */
  detail?: string;
  /**
   * Ask about any write, not only the statements `isDestructiveStatement`
   * flags.
   *
   * That list deliberately leaves out UPDATE and INSERT: typing one is the
   * ordinary business of a SQL client, and prompting each time would train the
   * user to dismiss the dialog. Direct manipulation is a different act. Nobody
   * composes a statement to edit a grid cell — a stray keystroke and a click on
   * Save is the whole gesture — so on production the grid asks about all of
   * its writes.
   */
  alwaysAsk?: boolean;
}

/**
 * Ask before running something destructive on production.
 *
 * Resolves true when there is nothing to ask about — a non-production
 * connection, or a statement that only reads or writes rows — so a caller can
 * gate unconditionally without deciding for itself what counts as dangerous.
 */
export async function confirmDestructive(
  options: ConfirmDestructiveOptions,
): Promise<boolean> {
  const { connectionId, sql, action, detail, alwaysAsk } = options;
  if (!isProductionConnection(connectionId)) return true;

  const statements = Array.isArray(sql) ? sql : [sql];
  if (!alwaysAsk && !statements.some(isDestructiveStatement)) return true;

  return useProductionGuardStore.getState().ask({
    title: "Run on production?",
    message: detail ? `${action}\n\n${detail}` : action,
    confirmLabel: "Run anyway",
  });
}

/**
 * Ask before dropping something, in the app's own dialog.
 *
 * These used `window.confirm`, which is unstyled, blocks the whole window and
 * cannot be tested without stubbing a global (routine audit F9).
 *
 * On a production connection this returns true without asking: the drop runs
 * through `resultStore`, whose production gate raises its own dialog naming
 * the statement, and two confirmations in a row for one click is worse than
 * one. The production dialog is the stronger of the two, so it is the one
 * that survives.
 */
export async function confirmDrop(
  connectionId: string,
  subject: string,
): Promise<boolean> {
  if (isProductionConnection(connectionId)) return true;
  return useProductionGuardStore.getState().ask({
    title: "Drop it?",
    message: `${subject} will be dropped. This cannot be undone.`,
    confirmLabel: "Drop",
  });
}
