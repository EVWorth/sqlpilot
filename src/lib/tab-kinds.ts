import type { EditorTab, RoutineKind } from "../types";

/**
 * What each kind of editor tab is, as data.
 *
 * `editorStore` had one `add*Tab` method per kind, each ~30 lines repeating
 * the same shape: look for an open tab with the same identity, activate it if
 * found, otherwise build one and append. Adding a kind meant a union member, a
 * method, a dedup block, and a title rule scattered across a 437-line store
 * (#286).
 *
 * A kind is now three answers — what identifies a tab of this kind, what it is
 * called, and what fields it carries — and the store has one `openTab` that
 * uses them.
 */

/** What opening a tab of each kind needs to know. */
export interface TabParams {
  query: { connectionId?: string; database?: string };
  structure: { connectionId: string; database: string; tableName: string };
  admin: { connectionId: string };
  routine: {
    connectionId: string;
    database: string;
    routineName: string;
    routineType: RoutineKind;
  };
  designer: { connectionId: string; database: string; tableName?: string };
}

export type TabKind = keyof TabParams;

interface TabSpec<K extends TabKind> {
  /**
   * Whether an open tab is already this one.
   *
   * Null for kinds that never dedup — a second query tab is a second query
   * tab, which is the whole point of tabs.
   */
  identity: ((tab: EditorTab, params: TabParams[K]) => boolean) | null;
  title: (params: TabParams[K]) => string;
  /** The kind-specific fields, beyond id, title, content and isDirty. */
  fields: (params: TabParams[K]) => Partial<EditorTab>;
}

/**
 * The icons are text rather than components because a tab's title is a string
 * that also reaches the session file and the window title.
 */
const SPECS: { [K in TabKind]: TabSpec<K> } = {
  query: {
    identity: null,
    title: () => "Untitled Query",
    fields: ({ connectionId, database }) => ({ type: "query", connectionId, database }),
  },

  structure: {
    identity: (tab, p) =>
      tab.type === "structure"
      && tab.connectionId === p.connectionId
      && tab.database === p.database
      && tab.tableName === p.tableName,
    title: (p) => `⊞ ${p.tableName}`,
    fields: (p) => ({
      type: "structure",
      connectionId: p.connectionId,
      database: p.database,
      tableName: p.tableName,
    }),
  },

  admin: {
    // One per connection: the admin panel is about the server, and a second
    // copy of it would show the same thing.
    identity: (tab, p) => tab.type === "admin" && tab.connectionId === p.connectionId,
    title: () => "🔧 Admin",
    fields: (p) => ({ type: "admin", connectionId: p.connectionId }),
  },

  routine: {
    identity: (tab, p) =>
      tab.type === "routine"
      && tab.connectionId === p.connectionId
      && tab.database === p.database
      && tab.routineName === p.routineName
      && tab.routineType === p.routineType,
    title: (p) => `${p.routineType === "PROCEDURE" ? "⚙" : "ƒ"} ${p.routineName}`,
    fields: (p) => ({
      type: "routine",
      connectionId: p.connectionId,
      database: p.database,
      routineName: p.routineName,
      routineType: p.routineType,
    }),
  },

  designer: {
    identity: (tab, p) =>
      tab.type === "designer"
      && tab.connectionId === p.connectionId
      && tab.database === p.database
      // Normalised: "" and undefined both mean a new table, and treating them
      // as different opens a second designer for the same thing.
      && (tab.tableName || undefined) === (p.tableName || undefined),
    title: (p) => (p.tableName ? `🔧 ${p.tableName}` : "🔧 New Table"),
    fields: (p) => ({
      type: "designer",
      connectionId: p.connectionId,
      database: p.database,
      tableName: p.tableName || undefined,
    }),
  },
};

/** An open tab of this kind with this identity, or undefined. */
export function findOpenTab<K extends TabKind>(
  tabs: EditorTab[],
  kind: K,
  params: TabParams[K],
): EditorTab | undefined {
  const identity = SPECS[kind].identity;
  if (!identity) return undefined;
  return tabs.find((tab) => identity(tab, params));
}

/** Build a tab of this kind. The caller supplies the id. */
export function buildTab<K extends TabKind>(
  id: string,
  kind: K,
  params: TabParams[K],
): EditorTab {
  return {
    id,
    title: SPECS[kind].title(params),
    content: "",
    isDirty: false,
    ...SPECS[kind].fields(params),
  } as EditorTab;
}

/** Every kind there is, for tests that should fail when one is added. */
export const TAB_KINDS = Object.keys(SPECS) as TabKind[];
