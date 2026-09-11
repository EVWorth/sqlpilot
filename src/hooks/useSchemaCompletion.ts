import { useMemo } from "react";
import type { SchemaData } from "../lib/schema-completion-provider";
import { schemaFor, useSchemaStore } from "../stores/schemaStore";

/**
 * What the editor's autocomplete knows, derived from the one schema store.
 *
 * There used to be a second cache — `schemaCacheStore` — holding the same
 * objects as name-only lists for exactly this. Two caches of one thing meant
 * two invalidations, and only one of them ran: the toolbar's refresh cleared
 * the autocomplete's copy while the tree kept showing what it had, and a
 * refresh from the tree did the opposite (#289).
 *
 * The completion provider wants `Map<string, string[]>`, so the names are
 * projected here rather than stored twice.
 */
export function useSchemaCompletion(connectionId: string | null): SchemaData {
  const schema = useSchemaStore((s) => schemaFor(s, connectionId));

  return useMemo(() => {
    const names = <T extends { name: string }>(source: Record<string, T[]>) =>
      new Map(Object.entries(source).map(([db, items]) => [db, items.map((i) => i.name)]));

    return {
      connectionId,
      databases: (schema.databases ?? []).map((d) => d.name),
      tables: names(schema.tables),
      views: names(schema.views),
      columns: new Map(Object.entries(schema.columns)),
      fetchTables: async (connId, db) => (await useSchemaStore.getState().ensureTables(connId, db)).map((t) => t.name),
      fetchViews: async (connId, db) => (await useSchemaStore.getState().ensureViews(connId, db)).map((v) => v.name),
      fetchColumns: (connId, db, table) => useSchemaStore.getState().ensureColumns(connId, db, table),
    };
  }, [connectionId, schema]);
}
