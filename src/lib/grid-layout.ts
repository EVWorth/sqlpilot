/**
 * Column order, remembered per result shape.
 *
 * FR-3.1.5 asks for reorder that persists "per query/table". Keying on the
 * query text alone would forget the layout the moment a WHERE clause changed,
 * which is the common case — you narrow the same SELECT a dozen times in a
 * session. Keying on the *columns* instead means any query returning the same
 * shape gets the same layout, which is what someone who dragged `email` to the
 * front actually meant (#392).
 *
 * Stored per connection and database, because the same column names on a
 * different server are a different table.
 */

const PREFIX = "sqlpilot.grid-layout";

/** How many shapes to remember before dropping some. */
const MAX_ENTRIES = 200;

export interface GridLayout {
  /** Column ids, in display order. Names not in the result are ignored. */
  columnOrder: string[];
}

/**
 * A stable id for "a result with these columns from here".
 *
 * Column order is deliberately part of it: the same names in a different
 * SELECT order are a different query, and inheriting a drag from one into the
 * other would look like the grid rearranging itself.
 */
export function layoutKey(
  connectionId: string | null | undefined,
  database: string | null | undefined,
  columns: string[],
): string | null {
  if (!connectionId || columns.length === 0) return null;
  return `${PREFIX}:${connectionId}:${database ?? ""}:${columns.join(" ")}`;
}

export function readLayout(key: string | null): GridLayout | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" || parsed === null
      || !Array.isArray((parsed as GridLayout).columnOrder)
    ) {
      return null;
    }
    return {
      columnOrder: (parsed as GridLayout).columnOrder.filter((c) => typeof c === "string"),
    };
  } catch {
    // Private-browsing storage, a quota error, or somebody's hand-edited JSON.
    // A forgotten column order is not worth failing the grid over.
    return null;
  }
}

export function writeLayout(key: string | null, layout: GridLayout): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(layout));
    evict();
  } catch {
    // Same reasoning as readLayout.
  }
}

/**
 * Keep the store bounded.
 *
 * Every distinct result shape leaves an entry behind, and a session spent
 * exploring a wide schema produces a lot of them. Without this the grid would
 * slowly fill the origin's storage quota and then start failing writes for
 * everything else in the app.
 */
function evict(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(`${PREFIX}:`)) keys.push(k);
    }
    if (keys.length <= MAX_ENTRIES) return;
    // No timestamps to sort by, and adding them would double the write cost.
    // Dropping a stable arbitrary slice is enough: these entries are a
    // convenience, and one lost layout costs a single drag.
    for (const k of keys.sort().slice(0, keys.length - MAX_ENTRIES)) {
      localStorage.removeItem(k);
    }
  } catch {
    // Nothing to do; the next write will try again.
  }
}

/**
 * Apply a remembered order to the columns a result actually has.
 *
 * Remembered names that are gone are dropped, and columns the order has never
 * seen keep their relative positions at the end — so adding a column to a
 * SELECT appends it rather than resetting the layout.
 */
export function applyOrder(remembered: string[], actual: string[]): string[] {
  const present = new Set(actual);
  const ordered = remembered.filter((c) => present.has(c));
  const placed = new Set(ordered);
  return [...ordered, ...actual.filter((c) => !placed.has(c))];
}

/** Move one column to sit where another one is, returning the new order. */
export function moveColumn(order: string[], from: string, to: string): string[] {
  if (from === to) return order;
  const fromIdx = order.indexOf(from);
  const toIdx = order.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return order;
  const next = [...order];
  next.splice(fromIdx, 1);
  next.splice(toIdx, 0, from);
  return next;
}
