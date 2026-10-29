// What the mock backend remembers between calls.
//
// In memory, reset on reload. Handler files read and change it; nothing else
// should, so a screen behaves the same however it was reached.

import type { ConnectionInfo, ConnectionProfileSummary_Serialize } from "../../lib/bindings";
import { PROFILES } from "./dataset";

/**
 * Which starting point the page was opened with: `?mock`, or
 * `?mock=<scenario>`. README.md lists them with the switches that combine
 * with them.
 *
 * - `default`: saved profiles, nothing connected.
 * - `empty`: a first run, with no saved profiles.
 * - `connected`: "Local dev" already connected, for jumping straight to the
 *   editor, the grid and the schema tree.
 */
export type Scenario = "default" | "empty" | "connected";

const SCENARIOS: readonly Scenario[] = ["default", "empty", "connected"];

export function scenarioFromUrl(search: string): Scenario {
  const value = new URLSearchParams(search).get("mock");
  return SCENARIOS.find((s) => s === value) ?? "default";
}

/**
 * Switches that combine with any scenario, each its own URL parameter.
 *
 * - `fail=<cmd>,<cmd>`: those commands reject (see `failures.ts`). A name
 *   ending in `*` matches every command that starts with the rest.
 */
export interface MockOptions {
  fail: string[];
}

export const defaultOptions = (): MockOptions => ({ fail: [] });

const list = (value: string | null): string[] => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function optionsFromUrl(search: string): MockOptions {
  const params = new URLSearchParams(search);
  return { fail: list(params.get("fail")) };
}

export const state = {
  scenario: "default" as Scenario,
  options: defaultOptions(),
  profiles: [] as ConnectionProfileSummary_Serialize[],
  /** Live connections, by connection id. */
  connections: new Map<string, ConnectionInfo>(),
  /** Counter for ids the mock hands out. */
  nextId: 1,
};

export function newId(prefix: string): string {
  return `${prefix}-${state.nextId++}`;
}

export function resetState(scenario: Scenario, options: MockOptions = defaultOptions()): void {
  state.scenario = scenario;
  state.options = options;
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
