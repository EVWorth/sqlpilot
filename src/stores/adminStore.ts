import { create } from "zustand";
import { runStatement } from "../lib/run-statement";
import { quoteStringLiteral } from "../lib/sql-quote";
import { api } from "../lib/tauri-api";
import type { ProcessInfo, ServerVariable } from "../types";

/**
 * What the admin panel's tabs read from the server (#862).
 *
 * The tabs called the API themselves and kept their own loading and error
 * state. Entries are keyed by the view that asked (a `useId` per mounted
 * tab), so each tab reads fresh when it opens and two panels on one server do
 * not share a half-finished answer. A view releases its entries when it
 * unmounts.
 */

export interface ProcessListEntry {
  processes: ProcessInfo[];
  /**
   * The sessions this app is itself using on the server. Killing one
   * disconnects the app from the server it is managing (#433).
   */
  ownThreadIds: number[];
  loading: boolean;
  error: string | null;
}

export interface VariablesEntry {
  variables: ServerVariable[];
  loading: boolean;
  error: string | null;
}

export interface GrantsEntry {
  /** One `GRANT …` line per row of `SHOW GRANTS`. */
  grants: string[];
  loading: boolean;
  error: string | null;
}

/** Whether a kill ends only the running statement or the whole session (#430). */
export type KillScope = "query" | "connection";

interface LoadOptions {
  /**
   * A refresh in the background: `loading` is left alone, so the tab keeps
   * what it shows rather than dropping back to a spinner (#819).
   */
  background?: boolean;
}

interface AdminState {
  processLists: Record<string, ProcessListEntry>;
  variables: Record<string, VariablesEntry>;
  grants: Record<string, GrantsEntry>;

  loadProcesses: (view: string, connectionId: string, options?: LoadOptions) => Promise<void>;
  /**
   * Kill a process, or only its running statement. Resolves to whether it
   * worked; a failure is put in the view's process list `error`.
   */
  killProcess: (view: string, connectionId: string, processId: number, scope: KillScope) => Promise<boolean>;
  loadVariables: (view: string, connectionId: string, options?: LoadOptions) => Promise<void>;
  loadGrants: (view: string, connectionId: string, user: string, host: string) => Promise<void>;

  /**
   * The account's grant lines, for a caller that keeps them itself. Null when
   * the server sent no result set. Rejects as the API does.
   */
  showGrants: (connectionId: string, user: string, host: string) => Promise<string[] | null>;
  /** The server's database names. Rejects as the API does. */
  listDatabaseNames: (connectionId: string) => Promise<string[]>;

  /** Drop everything held for a view, when it unmounts. */
  release: (view: string) => void;
}

const NO_PROCESSES: ProcessListEntry = { processes: [], ownThreadIds: [], loading: true, error: null };
const NO_VARIABLES: VariablesEntry = { variables: [], loading: true, error: null };
const NO_GRANTS: GrantsEntry = { grants: [], loading: true, error: null };

/** A view's entry, with a shared not-yet-loaded one until it has any. */
export function processListOf(state: Pick<AdminState, "processLists">, view: string): ProcessListEntry {
  return state.processLists[view] ?? NO_PROCESSES;
}
export function variablesOf(state: Pick<AdminState, "variables">, view: string): VariablesEntry {
  return state.variables[view] ?? NO_VARIABLES;
}
export function grantsOf(state: Pick<AdminState, "grants">, view: string): GrantsEntry {
  return state.grants[view] ?? NO_GRANTS;
}

type Slice = "processLists" | "variables" | "grants";

/**
 * The latest read per slice and view, so an answer for a connection the tab
 * has since left cannot land on top of the one it switched to.
 */
const latest = new Map<string, number>();
let counter = 0;

function begin(slice: Slice, view: string): () => boolean {
  const key = `${slice}\u0000${view}`;
  const token = ++counter;
  latest.set(key, token);
  return () => latest.get(key) === token;
}

/**
 * Every `SHOW GRANTS` the app makes goes through here, recorded as an internal
 * read, so the account view and the privileges editor do not differ in what
 * history shows (#921).
 */
async function readGrants(connectionId: string, user: string, host: string): Promise<string[] | null> {
  const results = await runStatement({
    connectionId,
    sql: `SHOW GRANTS FOR ${quoteStringLiteral(user)}@${quoteStringLiteral(host)}`,
    origin: "internal",
  });
  if (results.length === 0) return null;
  return results[0].rows.map((row) => String(row[0] ?? ""));
}

export const useAdminStore = create<AdminState>((set, get) => {
  function patch<K extends Slice>(
    slice: K,
    view: string,
    empty: AdminState[K][string],
    change: Partial<AdminState[K][string]>,
  ) {
    set((s) =>
      ({
        [slice]: { ...s[slice], [view]: { ...(s[slice][view] ?? empty), ...change } },
      }) as Partial<AdminState>
    );
  }

  return {
    processLists: {},
    variables: {},
    grants: {},

    loadProcesses: async (view, connectionId, options) => {
      const current = begin("processLists", view);
      if (!options?.background) patch("processLists", view, NO_PROCESSES, { loading: true });
      try {
        const [processes, own] = await Promise.all([
          api.getProcessList(connectionId),
          api.getOwnThreadIds(connectionId),
        ]);
        if (!current()) return;
        patch("processLists", view, NO_PROCESSES, { processes, ownThreadIds: own, error: null, loading: false });
      } catch (e) {
        if (!current()) return;
        patch("processLists", view, NO_PROCESSES, { error: String(e), loading: false });
      }
    },

    killProcess: async (view, connectionId, processId, scope) => {
      try {
        if (scope === "query") {
          await api.killQuery(connectionId, processId);
        } else {
          await api.killProcess(connectionId, processId);
        }
        return true;
      } catch (e) {
        // A tab closed meanwhile has nothing to show it in.
        if (!(view in get().processLists)) return false;
        patch("processLists", view, NO_PROCESSES, {
          error: `Failed to kill ${scope === "query" ? "query on" : "connection"} ${processId}: ${e}`,
        });
        return false;
      }
    },

    loadVariables: async (view, connectionId, options) => {
      const current = begin("variables", view);
      if (!options?.background) patch("variables", view, NO_VARIABLES, { loading: true });
      try {
        const variables = await api.getServerVariables(connectionId);
        if (!current()) return;
        patch("variables", view, NO_VARIABLES, { variables, error: null, loading: false });
      } catch (e) {
        if (!current()) return;
        patch("variables", view, NO_VARIABLES, { error: String(e), loading: false });
      }
    },

    loadGrants: async (view, connectionId, user, host) => {
      const current = begin("grants", view);
      patch("grants", view, NO_GRANTS, { loading: true, error: null });
      try {
        const grants = await readGrants(connectionId, user, host);
        if (!current()) return;
        // No result set leaves what was shown, as it always has.
        patch("grants", view, NO_GRANTS, grants ? { grants, loading: false } : { loading: false });
      } catch (e) {
        if (!current()) return;
        patch("grants", view, NO_GRANTS, { error: String(e), loading: false });
      }
    },

    showGrants: (connectionId, user, host) => readGrants(connectionId, user, host),

    listDatabaseNames: async (connectionId) => (await api.getDatabases(connectionId)).map((d) => d.name),

    release: (view) => {
      for (const slice of ["processLists", "variables", "grants"] as const) {
        latest.delete(`${slice}\u0000${view}`);
      }
      set((s) => {
        if (!(view in s.processLists) && !(view in s.variables) && !(view in s.grants)) return s;
        const processLists = { ...s.processLists };
        const variables = { ...s.variables };
        const grants = { ...s.grants };
        delete processLists[view];
        delete variables[view];
        delete grants[view];
        return { processLists, variables, grants };
      });
    },
  };
});
