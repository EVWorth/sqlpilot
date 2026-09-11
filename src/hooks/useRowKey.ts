import { useEffect, useState } from "react";
import { resolveEditTarget } from "../lib/sql-generator";
import { api } from "../lib/tauri-api";
import type { ColumnMeta } from "../types";

/**
 * How a grid row can be addressed in an UPDATE or DELETE.
 *
 * The result-set metadata cannot answer this. sqlx keeps MySQL's column flags
 * — including PRI_KEY_FLAG — behind `pub(crate)`, so `build_select_result` has
 * no way to populate `is_primary_key` and hardcodes false for every column
 * (#387). The frontend then fell back to matching on every column, which is
 * fragile in a way that fails silently: `WHERE email = 'old@example.com'`
 * never matches a row whose email is NULL, because NULL is not equal to
 * anything, so the save reported success and changed nothing (#400).
 *
 * When a table has no PRIMARY KEY, a UNIQUE index over NOT NULL columns
 * identifies a row just as exactly, and MySQL itself treats the first such
 * index as the clustered key. Using it is what keeps editing usable on the
 * tables that most often lack a declared primary key.
 *
 * The key is resolved from the schema when the result arrives, not when Save
 * is pressed. The user needs to know their edits are addressable *before*
 * making them — a warning that appears only after a failed save is a warning
 * that came too late.
 */

/** Where the identifying columns came from, which the warning text needs. */
export type KeySource = "primary-key" | "unique-index";

export type RowKeyState =
  | { status: "unknown" }
  /** No single table, so nothing is editable — a join, or a computed result. */
  | { status: "not-a-table" }
  /** The table has a key and every part of it is on screen. */
  | { status: "ready"; table: string; columns: string[]; source: KeySource }
  /** The table has a key but the query did not select all of it. */
  | { status: "key-not-selected"; table: string; columns: string[]; source: KeySource }
  /** The table has no primary key at all. */
  | { status: "no-key"; table: string };

export interface RowKey {
  state: RowKeyState;
  /**
   * The columns to match on, which is the key when there is one.
   *
   * Falls back to every column only when the table genuinely has no key —
   * the case where there is nothing better to match on.
   */
  columns: string[];
  /** True when a row can be addressed exactly. */
  addressable: boolean;
}

export function useRowKey(
  connectionId: string | null | undefined,
  database: string | null | undefined,
  sql: string | null | undefined,
  columns: ColumnMeta[] | undefined,
): RowKey {
  const [state, setState] = useState<RowKeyState>({ status: "unknown" });

  // Depend on the names rather than the array, which is a new object on every
  // fetch even when the shape has not changed.
  const columnNames = columns?.map((c) => c.name).join(" ") ?? "";

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!connectionId || !sql || !columnNames) {
        setState({ status: "unknown" });
        return;
      }

      const target = resolveEditTarget(sql);
      if (!target.editable || !target.table) {
        setState({ status: "not-a-table" });
        return;
      }
      if (!database) {
        // Without a database the schema cannot be asked. Not knowing is not
        // the same as knowing there is no key.
        setState({ status: "unknown" });
        return;
      }

      try {
        const schema = await api.getColumns(connectionId, database, target.table);
        if (cancelled) return;

        let source: KeySource = "primary-key";
        let key = schema.filter((c) => c.is_primary_key).map((c) => c.name);

        if (key.length === 0) {
          // A UNIQUE index over NOT NULL columns addresses a row exactly too.
          // Nullable ones do not: two rows may both hold NULL there, because
          // UNIQUE does not constrain NULLs in MySQL.
          const notNull = new Set(schema.filter((c) => !c.nullable).map((c) => c.name));
          const indexes = await api.getIndexes(connectionId, database, target.table);
          if (cancelled) return;
          const usable = indexes
            .filter((i) => i.is_unique && i.columns.length > 0)
            .filter((i) => i.columns.every((c) => notNull.has(c)))
            // Narrowest first: fewer columns is a shorter WHERE and a likelier
            // index hit.
            .sort((a, b) => a.columns.length - b.columns.length)[0];
          if (usable) {
            key = usable.columns;
            source = "unique-index";
          }
        }

        if (key.length === 0) {
          setState({ status: "no-key", table: target.table });
          return;
        }

        const selected = columnNames.split(" ");
        const onScreen = key.filter((name) => selected.includes(name));
        setState(
          onScreen.length === key.length
            ? { status: "ready", table: target.table, columns: key, source }
            : { status: "key-not-selected", table: target.table, columns: key, source },
        );
      } catch {
        // A schema read that fails says nothing about whether a key exists,
        // and claiming there is none would invite exactly the all-columns
        // WHERE this exists to avoid.
        if (!cancelled) setState({ status: "unknown" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connectionId, database, sql, columnNames]);

  return {
    state,
    columns: state.status === "ready" ? state.columns : (columns?.map((c) => c.name) ?? []),
    addressable: state.status === "ready",
  };
}
