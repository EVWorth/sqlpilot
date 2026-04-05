import { create } from "zustand";
import { api } from "../lib/tauri-api";
import type { ColumnInfo } from "../types";

interface SchemaCache {
  connectionId: string | null;
  databases: string[];
  tables: Map<string, string[]>;
  views: Map<string, string[]>;
  routines: Map<string, string[]>;
  triggers: Map<string, string[]>;
  columns: Map<string, ColumnInfo[]>;
  loading: boolean;

  setConnection: (connectionId: string | null) => void;
  fetchDatabases: (connectionId: string) => Promise<string[]>;
  fetchTables: (connectionId: string, database: string) => Promise<string[]>;
  fetchViews: (connectionId: string, database: string) => Promise<string[]>;
  fetchRoutines: (connectionId: string, database: string) => Promise<string[]>;
  fetchTriggers: (connectionId: string, database: string) => Promise<string[]>;
  fetchColumns: (
    connectionId: string,
    database: string,
    table: string,
  ) => Promise<ColumnInfo[]>;
  refreshSchema: () => Promise<void>;
}

export const useSchemaCache = create<SchemaCache>((set, get) => ({
  connectionId: null,
  databases: [],
  tables: new Map(),
  views: new Map(),
  routines: new Map(),
  triggers: new Map(),
  columns: new Map(),
  loading: false,

  setConnection: (connectionId) => {
    const current = get().connectionId;
    if (current === connectionId) return;
    set({
      connectionId,
      databases: [],
      tables: new Map(),
      views: new Map(),
      routines: new Map(),
      triggers: new Map(),
      columns: new Map(),
    });
    if (connectionId) {
      get().fetchDatabases(connectionId);
    }
  },

  fetchDatabases: async (connectionId) => {
    const cached = get().databases;
    if (cached.length > 0 && get().connectionId === connectionId) {
      return cached;
    }
    try {
      set({ loading: true });
      const dbInfos = await api.getDatabases(connectionId);
      const names = dbInfos.map((d) => d.name);
      set({ databases: names, loading: false });

      // Eagerly pre-fetch tables for all databases so autocomplete works immediately
      for (const db of names) {
        get().fetchTables(connectionId, db);
      }

      return names;
    } catch {
      set({ loading: false });
      return [];
    }
  },

  fetchTables: async (connectionId, database) => {
    const cached = get().tables.get(database);
    if (cached) return cached;
    try {
      set({ loading: true });
      const tableInfos = await api.getTables(connectionId, database);
      const names = tableInfos.map((t) => t.name);
      set((state) => {
        const newTables = new Map(state.tables);
        newTables.set(database, names);
        return { tables: newTables, loading: false };
      });
      return names;
    } catch {
      set({ loading: false });
      return [];
    }
  },

  fetchViews: async (connectionId, database) => {
    const cached = get().views.get(database);
    if (cached) return cached;
    try {
      set({ loading: true });
      const viewInfos = await api.getViews(connectionId, database);
      const names = viewInfos.map((v) => v.name);
      set((state) => {
        const newViews = new Map(state.views);
        newViews.set(database, names);
        return { views: newViews, loading: false };
      });
      return names;
    } catch {
      set({ loading: false });
      return [];
    }
  },

  fetchRoutines: async (connectionId, database) => {
    const cached = get().routines.get(database);
    if (cached) return cached;
    try {
      set({ loading: true });
      const routineInfos = await api.getRoutines(connectionId, database);
      const names = routineInfos.map((r) => r.name);
      set((state) => {
        const newRoutines = new Map(state.routines);
        newRoutines.set(database, names);
        return { routines: newRoutines, loading: false };
      });
      return names;
    } catch {
      set({ loading: false });
      return [];
    }
  },

  fetchTriggers: async (connectionId, database) => {
    const cached = get().triggers.get(database);
    if (cached) return cached;
    try {
      set({ loading: true });
      const triggerInfos = await api.getTriggers(connectionId, database);
      const names = triggerInfos.map((t) => t.name);
      set((state) => {
        const newTriggers = new Map(state.triggers);
        newTriggers.set(database, names);
        return { triggers: newTriggers, loading: false };
      });
      return names;
    } catch {
      set({ loading: false });
      return [];
    }
  },

  fetchColumns: async (connectionId, database, table) => {
    const key = `${database}.${table}`;
    const cached = get().columns.get(key);
    if (cached) return cached;
    try {
      set({ loading: true });
      const cols = await api.getColumns(connectionId, database, table);
      set((state) => {
        const newColumns = new Map(state.columns);
        newColumns.set(key, cols);
        return { columns: newColumns, loading: false };
      });
      return cols;
    } catch {
      set({ loading: false });
      return [];
    }
  },

  refreshSchema: async () => {
    const { connectionId } = get();
    if (!connectionId) return;
    set({
      databases: [],
      tables: new Map(),
      views: new Map(),
      routines: new Map(),
      triggers: new Map(),
      columns: new Map(),
    });
    await get().fetchDatabases(connectionId);
  },
}));
