import type { ConnectionInfo, QueryResult, SqlValue } from "../lib/bindings";
import type { EditorTab } from "../types";

/**
 * What the window tells an agent about itself.
 *
 * The requests arrive as events and are answered through a command; this
 * module is the part in between, kept pure so that "what does an agent see"
 * is a question with unit tests rather than one you answer by running the app
 * and attaching a harness.
 *
 * One rule shapes all of it: an agent addresses connections by **profile** id,
 * because that is what survives a restart and what a harness config names. The
 * app works in per-session connection ids. Every answer here translates.
 */

/** The editor's answer for `get_editor_context`. */
export interface EditorAnswer {
  tab: string;
  title: string;
  connection?: string;
  database?: string;
  sql: string;
  selection?: string;
}

/** The grid's answer for `get_result_context`. */
export interface ResultAnswer {
  sql: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionTimeMs: number;
  truncated: boolean;
  connection?: string;
}

/** The profile id behind a live connection id, when there is one. */
export function profileIdOf(
  connections: ConnectionInfo[],
  connectionId: string | undefined,
): string | undefined {
  if (!connectionId) return undefined;
  return connections.find((c) => c.id === connectionId)?.profile_id;
}

/** The live connection id for a profile, for answers that carry one back. */
export function connectionIdOf(
  connections: ConnectionInfo[],
  profileId: string | undefined,
): string | undefined {
  if (!profileId) return undefined;
  return connections.find((c) => c.profile_id === profileId)?.id;
}

/**
 * What the user is looking at.
 *
 * Returns null when the active tab is not a query tab — a structure or admin
 * tab has no statement to read, and inventing an empty one would have an agent
 * confidently rewriting nothing.
 */
export function editorAnswer(
  tabs: EditorTab[],
  activeTabId: string | null,
  connections: ConnectionInfo[],
  selection: string | undefined,
): EditorAnswer | null {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab || tab.type !== "query") return null;

  return {
    tab: tab.id,
    title: tab.title,
    connection: profileIdOf(connections, tab.connectionId),
    database: tab.database,
    sql: tab.content,
    // An empty selection is no selection. Sending "" would read as "the user
    // selected nothing on purpose", which is a different thing.
    selection: selection?.trim() ? selection : undefined,
  };
}

/** A cell, as JSON an agent can read. */
function cell(value: SqlValue): unknown {
  if (value === null) return null;
  // SqlValue arrives already JSON-shaped except for binary, which serialises
  // as an array of byte numbers — enormous and unreadable. The database tools
  // report a size instead, and this matches them.
  if (Array.isArray(value)) return `<${value.length} bytes>`;
  return value;
}

/**
 * The result on screen.
 *
 * Null when nothing has been run. The rows are included here and the *policy*
 * decides whether they leave — the window should not be the second place that
 * rule lives, because two places is how the rules drift apart.
 */
export function resultAnswer(
  results: QueryResult[],
  activeIndex: number,
  connectionId: string | undefined,
  connections: ConnectionInfo[],
): ResultAnswer | null {
  const result = results[activeIndex];
  if (!result) return null;

  return {
    sql: result.sql,
    columns: result.columns.map((c) => c.name),
    rows: result.rows.map((row) => row.map(cell)),
    rowCount: result.rows.length,
    executionTimeMs: result.execution_time_ms,
    truncated: result.rows_truncated,
    connection: profileIdOf(connections, connectionId),
  };
}

/**
 * Whether a proposal is about a tab that still exists and can take it.
 *
 * A tab id from `get_editor_context` can go stale — the user closes the tab
 * while the agent is thinking — and writing into whatever tab is active
 * instead would be the worst possible recovery.
 */
export function proposalTarget(
  tabs: EditorTab[],
  activeTabId: string | null,
  requested: string | null,
): EditorTab | null {
  const tab = requested
    ? tabs.find((t) => t.id === requested)
    : tabs.find((t) => t.id === activeTabId);
  if (!tab || tab.type !== "query") return null;
  return tab;
}

/** Why a proposal could not be shown, phrased for the agent that sent it. */
export function proposalRefusal(requested: string | null): string {
  return requested
    ? `There is no query tab with id "${requested}" any more — the user may have closed it. `
      + `Call get_editor_context for the tab they are looking at now.`
    : "There is no query tab open to change. Use open_draft to put this in a new tab instead.";
}
