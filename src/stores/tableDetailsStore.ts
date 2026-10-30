import { create } from "zustand";
import { dataSourceFor } from "../lib/datasource";
import { errorMessage } from "../lib/utils";
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, PartitionInfo, TableInfo } from "../types";

/**
 * What the table views read about one table: the structure panel and the
 * designer (#862).
 *
 * Both used to call the API themselves and keep their own loading and error
 * state. Entries are keyed by the view that asked (a `useId` per mounted
 * view), not by the table: each view reads fresh when it opens, two views of
 * the same table do not overwrite each other's answer, and a view that reads
 * fewer parts never blanks the parts another view showed. A view releases its
 * entries when it unmounts.
 */

/** One independent read about a table. */
export type TablePart = "columns" | "indexes" | "foreignKeys" | "partitions" | "ddl";

export interface TableTarget {
  connectionId: string;
  database: string;
  table: string;
}

export interface TableDetails {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  partitions: PartitionInfo[];
  ddl: string;
  /**
   * Why a part has nothing, by part.
   *
   * Each read is independent, so one failing must not blank the rest: a user
   * without rights on `information_schema.PARTITIONS` should still see their
   * columns (F3.14 of #299, #796). A part that was not asked for has no entry
   * and its empty default.
   */
  errors: Partial<Record<TablePart, string>>;
}

export interface TableDetailsEntry {
  /** Null until the first read has settled. */
  details: TableDetails | null;
  loading: boolean;
}

/** What a designer has read about the tables a foreign key may point at. */
export interface ReferenceEntry {
  tables: TableInfo[];
  /** Keyed by table name. */
  columns: Record<string, ColumnInfo[]>;
  /**
   * Why a table's columns could not be read, by table name. Swallowed, the
   * key's target columns vanished and the type check went quiet (#810).
   */
  columnErrors: Record<string, string>;
}

const NO_REFERENCES: ReferenceEntry = Object.freeze({
  tables: [],
  columns: {},
  columnErrors: {},
}) as ReferenceEntry;

interface TableDetailsState {
  details: Record<string, TableDetailsEntry>;
  references: Record<string, ReferenceEntry>;

  /**
   * Read the given parts of a table for a view, settled rather than all.
   *
   * Resolves to what was read, which is also stored under the view's key. A
   * read superseded by a later one for the same view is returned but not
   * stored.
   */
  loadDetails: (view: string, target: TableTarget, parts: readonly TablePart[]) => Promise<TableDetails>;

  /** The tables of a database, offered as foreign key targets. */
  loadReferenceTables: (view: string, connectionId: string, database: string) => Promise<void>;

  /**
   * A reference table's columns, read once per view. A failed read is not
   * remembered as read, so asking again retries it.
   */
  loadReferenceColumns: (view: string, target: TableTarget) => Promise<void>;

  /** Drop everything held for a view, when it unmounts. */
  release: (view: string) => void;
}

/** A view's reference entry, with a shared empty one until it has any. */
export function referencesOf(state: Pick<TableDetailsState, "references">, view: string): ReferenceEntry {
  return state.references[view] ?? NO_REFERENCES;
}

/**
 * One part, through the connection's data source like every other schema
 * read, so a SQLite file is not asked MySQL's questions (#921).
 */
function fetchPart(part: TablePart, { connectionId, database, table }: TableTarget): Promise<unknown> {
  const source = dataSourceFor(connectionId);
  switch (part) {
    case "columns":
      return source.getColumns(connectionId, database, table);
    case "indexes":
      return source.getIndexes(connectionId, database, table);
    case "foreignKeys":
      return source.getForeignKeys(connectionId, database, table);
    case "partitions":
      return source.getPartitions(connectionId, database, table);
    case "ddl":
      return source.getTableDdl(connectionId, database, table);
  }
}

/** The latest details read per view, so a slower earlier one cannot land on top. */
const latestRead = new Map<string, number>();
/**
 * A generation per view holding references, so an answer that lands after the
 * view released them does not bring the entry back.
 */
const referenceGeneration = new Map<string, number>();
let counter = 0;

function referenceGenerationOf(view: string): number {
  let generation = referenceGeneration.get(view);
  if (generation === undefined) {
    generation = ++counter;
    referenceGeneration.set(view, generation);
  }
  return generation;
}

export const useTableDetailsStore = create<TableDetailsState>((set, get) => {
  function putReferences(
    view: string,
    generation: number,
    patch: (entry: ReferenceEntry) => Partial<ReferenceEntry>,
  ) {
    if (referenceGeneration.get(view) !== generation) return;
    set((s) => {
      const current = referencesOf(s, view);
      return { references: { ...s.references, [view]: { ...current, ...patch(current) } } };
    });
  }

  return {
    details: {},
    references: {},

    loadDetails: async (view, target, parts) => {
      const token = ++counter;
      latestRead.set(view, token);
      set((s) => ({
        details: { ...s.details, [view]: { details: s.details[view]?.details ?? null, loading: true } },
      }));

      const settled = await Promise.allSettled(parts.map((part) => fetchPart(part, target)));
      const details: TableDetails = {
        columns: [],
        indexes: [],
        foreignKeys: [],
        partitions: [],
        ddl: "",
        errors: {},
      };
      parts.forEach((part, i) => {
        const result = settled[i];
        if (result.status === "rejected") {
          details.errors[part] = String(result.reason);
          return;
        }
        // Each part's fetch returns that part's own type.
        (details as unknown as Record<TablePart, unknown>)[part] = result.value;
      });

      if (latestRead.get(view) === token) {
        latestRead.delete(view);
        set((s) => ({ details: { ...s.details, [view]: { details, loading: false } } }));
      }
      return details;
    },

    loadReferenceTables: async (view, connectionId, database) => {
      const generation = referenceGenerationOf(view);
      try {
        const tables = await dataSourceFor(connectionId).listTables(connectionId, database);
        putReferences(view, generation, () => ({ tables }));
      } catch (e) {
        console.error("Failed to load reference tables", e);
      }
    },

    loadReferenceColumns: async (view, target) => {
      if (referencesOf(get(), view).columns[target.table]) return;
      const generation = referenceGenerationOf(view);
      try {
        const columns = await dataSourceFor(target.connectionId).getColumns(
          target.connectionId,
          target.database,
          target.table,
        );
        putReferences(view, generation, (entry) => {
          const columnErrors = { ...entry.columnErrors };
          delete columnErrors[target.table];
          return { columns: { ...entry.columns, [target.table]: columns }, columnErrors };
        });
      } catch (e) {
        putReferences(view, generation, (entry) => ({
          columnErrors: { ...entry.columnErrors, [target.table]: errorMessage(e) },
        }));
      }
    },

    release: (view) => {
      latestRead.delete(view);
      referenceGeneration.delete(view);
      set((s) => {
        if (!(view in s.details) && !(view in s.references)) return s;
        const details = { ...s.details };
        const references = { ...s.references };
        delete details[view];
        delete references[view];
        return { details, references };
      });
    },
  };
});
