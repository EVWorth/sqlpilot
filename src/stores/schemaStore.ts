import { create } from "zustand";
import { dataSourceFor } from "../lib/datasource";
import type { ColumnInfo, DatabaseInfo, EventInfo, RoutineInfo, TableInfo, TriggerInfo, ViewInfo } from "../types";

/**
 * What the app knows about each server's schema.
 *
 * The tree kept this in component state keyed only by database name, so two
 * connections with a database of the same name — `mysql` and `app` are on
 * nearly every server — showed each other's tables, and a context-menu action
 * ran against whichever server the tree happened to have been built from
 * (#288). A response that arrived after a switch repopulated the new tree with
 * the old server's objects.
 *
 * Refreshing had the matching problem: a database-level refresh reloaded only
 * tables, and the toolbar's full refresh cleared a *different* cache that the
 * tree never read, so the visible tree stayed stale while the autocomplete
 * updated (#289).
 *
 * One store, keyed by connection, with a generation counter per connection so
 * a response for a superseded generation is dropped rather than applied.
 */

/** Which kinds of object a database node holds, for scoped invalidation. */
export type SchemaFolder = "tables" | "views" | "routines" | "triggers" | "events";

interface ConnectionSchema {
  /** Undefined until fetched; an empty array means a server with no databases. */
  databases?: DatabaseInfo[];
  tables: Record<string, TableInfo[]>;
  views: Record<string, ViewInfo[]>;
  routines: Record<string, RoutineInfo[]>;
  triggers: Record<string, TriggerInfo[]>;
  events: Record<string, EventInfo[]>;
  /** Keyed `database.table`. */
  columns: Record<string, ColumnInfo[]>;
  /**
   * Bumped whenever anything is invalidated.
   *
   * A fetch captures it before awaiting and drops its result if it no longer
   * matches — which is what stops a slow response from a connection the user
   * has left behind, or from before a refresh, overwriting what replaced it.
   */
  generation: number;
  /** Keys with a request in flight, so the tree can say which node is loading. */
  loading: string[];
}

function emptySchema(): ConnectionSchema {
  return {
    // Explicitly present, so spreading this over an existing schema clears it.
    // Omitting the key leaves whatever was there, which made a full
    // invalidation keep the database list it was supposed to drop.
    databases: undefined,
    tables: {},
    views: {},
    routines: {},
    triggers: {},
    events: {},
    columns: {},
    generation: 0,
    loading: [],
  };
}

/**
 * One shared instance for connections nothing is known about yet.
 *
 * A selector that returned a fresh object each call would compare unequal on
 * every render and re-render the tree forever.
 */
const NOTHING_KNOWN: ConnectionSchema = Object.freeze(emptySchema());

interface SchemaState {
  byConnection: Record<string, ConnectionSchema>;

  ensureDatabases: (connectionId: string) => Promise<DatabaseInfo[]>;
  ensureTables: (connectionId: string, database: string) => Promise<TableInfo[]>;
  ensureViews: (connectionId: string, database: string) => Promise<ViewInfo[]>;
  ensureRoutines: (connectionId: string, database: string) => Promise<RoutineInfo[]>;
  ensureTriggers: (connectionId: string, database: string) => Promise<TriggerInfo[]>;
  ensureEvents: (connectionId: string, database: string) => Promise<EventInfo[]>;
  ensureColumns: (
    connectionId: string,
    database: string,
    table: string,
  ) => Promise<ColumnInfo[]>;

  /**
   * Drop what is cached and let the next read fetch it again.
   *
   * With no database, the whole connection. With a database and no folder,
   * every folder under it — which is what "refresh this database" means, and
   * what the old implementation got wrong by reloading only tables.
   */
  invalidate: (connectionId: string, database?: string, folder?: SchemaFolder) => void;

  /** Forget a connection entirely, on disconnect. */
  forget: (connectionId: string) => void;

  /** True when a request for this key is in flight. */
  isLoading: (connectionId: string, key: string) => boolean;

  /**
   * Throw away everything known about a connection and load it again.
   *
   * What the toolbar's Refresh and F5 do. It used to clear a cache the tree
   * never read, so the tree stayed stale while the autocomplete updated
   * (#289).
   */
  refreshAll: (connectionId: string) => Promise<void>;
}

/** The loading key for a folder under a database, or for the database list. */
export function loadKey(database?: string, folder?: SchemaFolder): string {
  if (!database) return "databases";
  return folder ? `${database}:${folder}` : database;
}

/**
 * Generations, kept outside the store so they survive `forget`.
 *
 * Held in the store alone, forgetting a connection reset its generation to
 * zero — which is what an in-flight fetch captured, so a response that landed
 * after the disconnect matched and was applied to a connection the user had
 * already left.
 */
const generations = new Map<string, number>();

function generationOf(connectionId: string): number {
  return generations.get(connectionId) ?? 0;
}

function bumpGeneration(connectionId: string): number {
  const next = generationOf(connectionId) + 1;
  generations.set(connectionId, next);
  return next;
}

export const useSchemaStore = create<SchemaState>((set, get) => {
  function schemaOf(connectionId: string): ConnectionSchema {
    return get().byConnection[connectionId] ?? NOTHING_KNOWN;
  }

  function update(connectionId: string, patch: Partial<ConnectionSchema>) {
    set((state) => ({
      byConnection: {
        ...state.byConnection,
        [connectionId]: { ...(state.byConnection[connectionId] ?? emptySchema()), ...patch },
      },
    }));
  }

  function setLoading(connectionId: string, key: string, on: boolean) {
    const current = schemaOf(connectionId).loading;
    const next = on
      ? current.includes(key) ? current : [...current, key]
      : current.filter((k) => k !== key);
    if (next !== current) update(connectionId, { loading: next });
  }

  /**
   * Fetch once, cache, and drop the answer if it is no longer wanted.
   *
   * `read` returns what is already cached, or undefined to go and get it.
   */
  async function ensure<T>(
    connectionId: string,
    key: string,
    read: (schema: ConnectionSchema) => T | undefined,
    fetch: () => Promise<T>,
    store: (schema: ConnectionSchema, value: T) => Partial<ConnectionSchema>,
    empty: T,
  ): Promise<T> {
    const cached = read(schemaOf(connectionId));
    if (cached !== undefined) return cached;

    const generation = generationOf(connectionId);
    setLoading(connectionId, key, true);
    try {
      const value = await fetch();
      // The connection may have been left, or the cache invalidated, while
      // this was in flight. Either way the answer is about a world that is
      // gone; applying it is what put the previous server's tables in the new
      // server's tree (#288).
      if (generationOf(connectionId) !== generation) return value;
      update(connectionId, store(schemaOf(connectionId), value));
      return value;
    } catch (e) {
      console.error(`Schema read failed for ${connectionId}/${key}:`, e);
      return empty;
    } finally {
      setLoading(connectionId, key, false);
    }
  }

  return {
    byConnection: {},

    ensureDatabases: (connectionId) =>
      ensure(
        connectionId,
        loadKey(),
        (s) => s.databases,
        () => dataSourceFor(connectionId).listDatabases(connectionId),
        (_s, databases) => ({ databases }),
        [],
      ),

    ensureTables: (connectionId, database) =>
      ensure(
        connectionId,
        loadKey(database),
        (s) => s.tables[database],
        () => dataSourceFor(connectionId).listTables(connectionId, database),
        (s, value) => ({ tables: { ...s.tables, [database]: value } }),
        [],
      ),

    ensureViews: (connectionId, database) =>
      ensure(
        connectionId,
        loadKey(database, "views"),
        (s) => s.views[database],
        () => dataSourceFor(connectionId).listViews(connectionId, database),
        (s, value) => ({ views: { ...s.views, [database]: value } }),
        [],
      ),

    ensureRoutines: (connectionId, database) =>
      ensure(
        connectionId,
        loadKey(database, "routines"),
        (s) => s.routines[database],
        () => dataSourceFor(connectionId).listRoutines(connectionId, database),
        (s, value) => ({ routines: { ...s.routines, [database]: value } }),
        [],
      ),

    ensureTriggers: (connectionId, database) =>
      ensure(
        connectionId,
        loadKey(database, "triggers"),
        (s) => s.triggers[database],
        () => dataSourceFor(connectionId).listTriggers(connectionId, database),
        (s, value) => ({ triggers: { ...s.triggers, [database]: value } }),
        [],
      ),

    ensureEvents: (connectionId, database) =>
      ensure(
        connectionId,
        loadKey(database, "events"),
        (s) => s.events[database],
        () => dataSourceFor(connectionId).listEvents(connectionId, database),
        (s, value) => ({ events: { ...s.events, [database]: value } }),
        [],
      ),

    ensureColumns: (connectionId, database, table) =>
      ensure(
        connectionId,
        `${database}.${table}`,
        (s) => s.columns[`${database}.${table}`],
        () => dataSourceFor(connectionId).getColumns(connectionId, database, table),
        (s, value) => ({ columns: { ...s.columns, [`${database}.${table}`]: value } }),
        [],
      ),

    invalidate: (connectionId, database, folder) => {
      const schema = schemaOf(connectionId);
      const generation = bumpGeneration(connectionId);

      if (!database) {
        update(connectionId, { ...emptySchema(), generation, loading: schema.loading });
        return;
      }

      if (!folder) {
        // Every folder under the database, plus any columns read from its
        // tables. Reloading only tables is what left views, routines and
        // triggers stale after a refresh (#289).
        const drop = <T>(map: Record<string, T>) => {
          const next = { ...map };
          delete next[database];
          return next;
        };
        update(connectionId, {
          generation,
          tables: drop(schema.tables),
          views: drop(schema.views),
          routines: drop(schema.routines),
          triggers: drop(schema.triggers),
          events: drop(schema.events),
          columns: Object.fromEntries(
            Object.entries(schema.columns).filter(([k]) => !k.startsWith(`${database}.`)),
          ),
        });
        return;
      }

      const key = folder;
      const next = { ...schema[key] };
      delete next[database];
      update(connectionId, { generation, [key]: next });
    },

    forget: (connectionId) => {
      bumpGeneration(connectionId);
      set((state) => {
        const next = { ...state.byConnection };
        delete next[connectionId];
        return { byConnection: next };
      });
    },

    isLoading: (connectionId, key) => schemaOf(connectionId).loading.includes(key),

    refreshAll: async (connectionId) => {
      get().invalidate(connectionId);
      const databases = await get().ensureDatabases(connectionId);
      // Sequential: a server with fifty databases would otherwise open fifty
      // concurrent reads on a pool sized for a handful.
      for (const database of databases) {
        await get().ensureTables(connectionId, database.name);
      }
    },
  };
});

/** Read-only view of one connection's schema, for a component's selector. */
export function schemaFor(state: SchemaState, connectionId: string | null | undefined) {
  return (connectionId && state.byConnection[connectionId]) || NOTHING_KNOWN;
}
