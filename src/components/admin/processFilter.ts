import type { ProcessInfo } from "../../types";

/**
 * Narrowing the process list.
 *
 * FR-7.2.1 asks for "filterable by user, database, state". There was one
 * free-text box matching every column at once, which cannot express "sleeping
 * connections belonging to app" — the question an admin actually has when the
 * connection count is climbing (#437).
 *
 * The free-text box stays alongside, because it answers a different question:
 * finding one thread by a fragment of its query.
 */

export interface ProcessFilters {
  /** Matched against every column. */
  search: string;
  /** Exact match, or "" for any. */
  user: string;
  database: string;
  state: string;
}

export const NO_PROCESS_FILTERS: ProcessFilters = {
  search: "",
  user: "",
  database: "",
  state: "",
};

/** True when anything is narrowing the list. */
export function hasProcessFilters(f: ProcessFilters): boolean {
  return f.search.trim() !== "" || f.user !== "" || f.database !== "" || f.state !== "";
}

/** What a process reports for a column that is empty, as the list shows it. */
const NONE = "—";

/** The value the dropdowns match on, so "no database" is selectable. */
function columnValue(value: string | null | undefined): string {
  return value == null || value === "" ? NONE : value;
}

/**
 * The distinct values worth offering, taken from what is actually connected.
 *
 * Offering every user on the server would list accounts with no threads; these
 * list only values that would return something. Sorted, with the empty
 * placeholder last so it does not head the list.
 */
export function processFilterOptions(processes: ProcessInfo[]) {
  const collect = (pick: (p: ProcessInfo) => string | null | undefined) => {
    const values = new Set(processes.map((p) => columnValue(pick(p))));
    return [...values].sort((a, b) => {
      if (a === NONE) return 1;
      if (b === NONE) return -1;
      return a.localeCompare(b);
    });
  };

  return {
    users: collect((p) => p.user),
    databases: collect((p) => p.db),
    states: collect((p) => p.state),
  };
}

/** Apply the filters. */
export function filterProcesses(
  processes: ProcessInfo[],
  filters: ProcessFilters,
): ProcessInfo[] {
  const search = filters.search.trim().toLowerCase();

  return processes.filter((p) => {
    if (filters.user && columnValue(p.user) !== filters.user) return false;
    if (filters.database && columnValue(p.db) !== filters.database) return false;
    if (filters.state && columnValue(p.state) !== filters.state) return false;
    if (!search) return true;

    // The free-text box still matches anywhere, including the query text,
    // which is how you find one thread you already know something about.
    return [p.id, p.user, p.host, p.db, p.command, p.state, p.info]
      .some((field) => String(field ?? "").toLowerCase().includes(search));
  });
}
