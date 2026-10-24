import { create } from "zustand";
import { dataSourceFor } from "../lib/datasource";
import { api } from "../lib/tauri-api";
import { errorMessage } from "../lib/utils";
import type { DdlObjectType } from "../types";

/**
 * The DDL behind each open DDL tab (#800).
 *
 * "Show DDL" used to run `SHOW CREATE …` as a query, which left the statement
 * in one ellipsized grid cell and opened a fresh dirty query tab on every
 * click. The schema API already returns the DDL as text, so this reads it from
 * there and the tab shows it in an editor.
 */

export interface DdlTarget {
  connectionId: string;
  database: string;
  objectName: string;
  objectType: DdlObjectType;
}

export interface DdlEntry {
  ddl: string | null;
  loading: boolean;
  error: string | null;
}

interface DdlState {
  entries: Record<string, DdlEntry>;
  load: (target: DdlTarget) => Promise<void>;
}

const EMPTY: DdlEntry = { ddl: null, loading: false, error: null };

/** One entry per object; the separator cannot appear in an identifier. */
export function ddlKey(t: DdlTarget): string {
  return [t.connectionId, t.database, t.objectType, t.objectName].join("\u0000");
}

function fetchDdl({ connectionId, database, objectName, objectType }: DdlTarget): Promise<string> {
  switch (objectType) {
    case "TABLE":
      // Through the data source, so a SQLite table gets its own DDL rather
      // than a MySQL statement it cannot run.
      return dataSourceFor(connectionId).getTableDdl(connectionId, database, objectName);
    case "VIEW":
      // Through the data source too: a SQLite view's DDL is not MySQL's (#825).
      return dataSourceFor(connectionId).getViewDdl(connectionId, database, objectName);
    case "TRIGGER":
      return api.getTriggerDdl(connectionId, database, objectName);
    case "PROCEDURE":
    case "FUNCTION":
      return api.getRoutineDdl(connectionId, database, objectName, objectType);
  }
}

export const useDdlStore = create<DdlState>((set) => ({
  entries: {},
  load: async (target) => {
    const key = ddlKey(target);
    const put = (patch: Partial<DdlEntry>) =>
      set((s) => ({
        entries: {
          ...s.entries,
          [key]: { ...(s.entries[key] ?? EMPTY), ...patch },
        },
      }));
    put({ loading: true, error: null });
    try {
      const ddl = await fetchDdl(target);
      put({ ddl, loading: false });
    } catch (e) {
      put({ error: errorMessage(e), loading: false });
    }
  },
}));
