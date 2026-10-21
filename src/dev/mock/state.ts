// What the mock backend remembers between calls.
//
// In memory, reset on reload. Handler files read and change it; nothing else
// should, so a screen behaves the same however it was reached.

import type { ConnectionInfo, ConnectionProfileSummary_Serialize } from "@/lib/bindings";
import { PROFILES } from "./dataset";

/**
 * Which starting point the page was opened with: `?mock`, or
 * `?mock=<scenario>`.
 *
 * - `default`: saved profiles, nothing connected.
 * - `empty`: a first run, with no saved profiles.
 * - `connected`: "Local dev" already connected, for jumping straight to the
 *   editor, the grid and the schema tree.
 */
export type Scenario = "default" | "empty" | "connected";

export function scenarioFromUrl(search: string): Scenario {
  const value = new URLSearchParams(search).get("mock");
  return value === "empty" || value === "connected" ? value : "default";
}

export const state = {
  scenario: "default" as Scenario,
  profiles: [] as ConnectionProfileSummary_Serialize[],
  /** Live connections, by connection id. */
  connections: new Map<string, ConnectionInfo>(),
  /** Counter for ids the mock hands out. */
  nextId: 1,
};

export function newId(prefix: string): string {
  return `${prefix}-${state.nextId++}`;
}

export function resetState(scenario: Scenario): void {
  state.scenario = scenario;
  state.profiles = scenario === "empty" ? [] : PROFILES.map((p) => ({ ...p }));
  state.connections.clear();
  state.nextId = 1;
}

/** The live connection for an id, or the error the backend gives. */
export function liveConnection(connectionId: unknown): ConnectionInfo {
  const conn = state.connections.get(String(connectionId));
  // The backend's wording: CoreError::NotFound around the manager's message.
  if (!conn) throw `Not found: Connection not found: ${String(connectionId)}`;
  return conn;
}
