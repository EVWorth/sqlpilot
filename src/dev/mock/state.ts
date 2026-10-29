// What the mock backend remembers between calls.
//
// In memory, reset on reload. Handler files read and change it; nothing else
// should, so a screen behaves the same however it was reached.

import type { ConnectionInfo, ConnectionProfileSummary_Serialize } from "../../lib/bindings";
import { PROFILES, SERVER_PROFILES } from "./dataset";

/**
 * Which starting point the page was opened with: `?mock`, or
 * `?mock=<scenario>`. README.md lists them with the switches that combine
 * with them.
 *
 * - `default`: saved profiles, nothing connected.
 * - `empty`: a first run, with no saved profiles.
 * - `connected`: "Local dev" already connected, for jumping straight to the
 *   editor, the grid and the schema tree.
 * - `lost`: `connected`, then the server stops answering a few seconds in:
 *   the health checks fail and keep failing, and every read on it fails.
 * - `servers`: the default profiles plus one per remaining connect outcome:
 *   a read-write production server, a MariaDB that connects, a wrong
 *   password and a server that never answers.
 */
export type Scenario = "default" | "empty" | "connected" | "lost" | "servers";

const SCENARIOS: readonly Scenario[] = ["default", "empty", "connected", "lost", "servers"];

/** Whether the scenario starts with "Local dev" connected. */
export const startsConnected = (scenario: Scenario) => scenario === "connected" || scenario === "lost";

export function scenarioFromUrl(search: string): Scenario {
  const value = new URLSearchParams(search).get("mock");
  return SCENARIOS.find((s) => s === value) ?? "default";
}

/**
 * Switches that combine with any scenario, each its own URL parameter.
 *
 * - `fail=<cmd>,<cmd>`: those commands reject (see `failures.ts`). A name
 *   ending in `*` matches every command that starts with the rest.
 * - `update=available|downloading|download-error|error`: what the updater
 *   finds (see handlers/plugins.ts). Absent: up to date.
 * - `keyring=missing`: no OS credential store.
 * - `startup=problems`: the backend reports that the connection and history
 *   stores could not be opened.
 */
export interface MockOptions {
  fail: string[];
  update: UpdateMode;
  keyring: boolean;
  startupProblems: boolean;
}

export type UpdateMode = "none" | "available" | "downloading" | "download-error" | "error";

const UPDATE_MODES: readonly UpdateMode[] = ["none", "available", "downloading", "download-error", "error"];

export const defaultOptions = (): MockOptions => ({
  fail: [],
  update: "none",
  keyring: true,
  startupProblems: false,
});

const list = (value: string | null): string[] => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function optionsFromUrl(search: string): MockOptions {
  const params = new URLSearchParams(search);
  return {
    fail: list(params.get("fail")),
    update: UPDATE_MODES.find((m) => m === params.get("update")) ?? "none",
    keyring: params.get("keyring") !== "missing",
    startupProblems: params.get("startup") === "problems",
  };
}

export const state = {
  scenario: "default" as Scenario,
  options: defaultOptions(),
  profiles: [] as ConnectionProfileSummary_Serialize[],
  /** Live connections, by connection id. */
  connections: new Map<string, ConnectionInfo>(),
  /**
   * Connections whose server has stopped answering, with how many health
   * checks have failed in a row.
   */
  down: new Map<string, number>(),
  /** Counter for ids the mock hands out. */
  nextId: 1,
};

export function newId(prefix: string): string {
  return `${prefix}-${state.nextId++}`;
}

export function resetState(scenario: Scenario, options: MockOptions = defaultOptions()): void {
  state.scenario = scenario;
  state.options = options;
  const profiles = scenario === "empty" ? [] : scenario === "servers" ? [...PROFILES, ...SERVER_PROFILES] : PROFILES;
  state.profiles = profiles.map((p) => ({ ...p }));
  state.connections.clear();
  state.down.clear();
  state.nextId = 1;
}

/** What a read on a connection whose server has gone fails with. */
export const LOST_CONNECTION =
  "error returned from database: 2013 (HY000): Lost connection to MySQL server during query";

/**
 * The live connection for an id, or the error the backend gives.
 *
 * A connection whose server has gone (`?mock=lost`) fails too, as every
 * command that talks to the server would; `evenIfDown` is for the few that
 * do not, such as disconnecting.
 */
export function liveConnection(connectionId: unknown, { evenIfDown = false } = {}): ConnectionInfo {
  const conn = state.connections.get(String(connectionId));
  // The backend's wording: CoreError::NotFound around the manager's message.
  if (!conn) throw `Not found: Connection not found: ${String(connectionId)}`;
  if (!evenIfDown && state.down.has(conn.id)) throw `Query error: ${LOST_CONNECTION}`;
  return conn;
}
