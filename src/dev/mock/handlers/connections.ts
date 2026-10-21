// Connection profiles, connecting, and connection health.
//
// Three profiles behave differently on purpose, so every connect state can be
// looked at: "Staging" takes a second and a half (the connecting spinner),
// "MariaDB sandbox" is refused (the connect error), and "Production" is
// read-only (the query handlers refuse writes on it). The rest connect at
// once.

import { emit } from "@tauri-apps/api/event";
import type {
  ConnectionHealth,
  ConnectionInfo,
  ConnectionProfileSummary_Serialize,
  ConnectionProfile_Deserialize,
  StartupProblem,
  TestConnectionResult,
} from "@/lib/bindings";
import { SERVER_VERSION } from "../dataset";
import { delay, fail, type Handlers } from "../router";
import { liveConnection, newId, state } from "../state";

const SLOW_PROFILE = "profile-staging";
const SCENARIO_PROFILE = "profile-local";

/** What a profile's server is, for one the dataset does not list. */
const versionOf = (profileId: string): string => SERVER_VERSION[profileId] ?? "8.0.39";

/**
 * Whether connecting to this address is refused.
 *
 * Keyed on the address rather than only the profile id, so a profile created
 * in the dialog pointing at the same port fails the same way.
 */
function isRefused(p: { id: string; host: string; port: number }): boolean {
  return p.id === "profile-maria" || (["localhost", "127.0.0.1"].includes(p.host) && p.port === 3307);
}

// The driver's own text, with the hint the backend adds for a refused TCP
// connection (`diagnose_connect_error` in mas-core).
const refusedDetail = (host: string, port: number) =>
  `Nothing is listening on ${host}:${port}. The server is stopped, or it is listening on a different port. `
  + "(error communicating with database: Connection refused (os error 111))";

/** The backend refuses SSH profiles outright rather than bypass the tunnel. */
function refuseSsh(p: ConnectionProfile_Deserialize | ConnectionProfileSummary_Serialize): void {
  const ssh = p.ssh_config;
  if (!ssh || !ssh.host.trim()) return;
  fail(
    `SSH tunnel error: This profile is set to tunnel through ${ssh.host}, but SSH tunnelling is not `
      + `implemented yet. Connecting would have gone straight to ${p.host}:${p.port} instead, which is `
      + "not what the tunnel settings say. Remove the SSH settings to connect directly, or open a "
      + "tunnel yourself and point the profile at the forwarded local port.",
  );
}

function openConnection(profile: ConnectionProfileSummary_Serialize): ConnectionInfo {
  const info: ConnectionInfo = {
    id: newId("conn"),
    profile_id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    database: profile.default_database,
    server_version: versionOf(profile.id),
    connected_at: new Date().toISOString(),
    color: profile.color,
    environment: profile.environment,
  };
  state.connections.set(info.id, info);
  return info;
}

/** Small, stable latency per connection, so the status bar has a number. */
const latencyOf = (connectionId: string) => 2 + (connectionId.length % 5);

const healthy = (connectionId: string): ConnectionHealth => ({
  connectionId,
  healthy: true,
  latencyMs: latencyOf(connectionId),
  error: null,
  consecutiveFailures: 0,
});

/**
 * The "Local dev" connection the `connected` scenario starts with.
 *
 * Made on first ask rather than at install, so it exists whichever command
 * the app happens to reach first. Note the frontend never lists backend
 * connections on startup, so whatever opens the scenario still has to call
 * the connection store's `connect("profile-local")`; that call gets this
 * connection back instead of a second one.
 */
export function scenarioConnection(): ConnectionInfo | undefined {
  if (state.scenario !== "connected") return undefined;
  const existing = [...state.connections.values()].find((c) => c.profile_id === SCENARIO_PROFILE);
  if (existing) return existing;
  const profile = state.profiles.find((p) => p.id === SCENARIO_PROFILE);
  return profile ? openConnection(profile) : undefined;
}

export const connectionHandlers: Handlers = {
  list_connection_profiles: async (): Promise<ConnectionProfileSummary_Serialize[]> => {
    await delay(60);
    return state.profiles.map((p) => ({ ...p }));
  },

  save_connection_profile: async (args): Promise<string> => {
    const input = args.profile as ConnectionProfile_Deserialize;
    await delay();
    const id = input.id || newId("profile");
    const existing = state.profiles.find((p) => p.id === id);
    const now = new Date().toISOString();
    // Credentials are never echoed back, exactly as the real summary omits them.
    const { ssh_config } = input;
    // Listed field by field: spreading the input would carry the password.
    const summary: ConnectionProfileSummary_Serialize = {
      id,
      name: input.name,
      group: input.group,
      color: input.color,
      host: input.host,
      port: input.port,
      username: input.username,
      default_database: input.default_database,
      ssl_config: input.ssl_config,
      read_only: input.read_only,
      connect_timeout_secs: input.connect_timeout_secs,
      query_timeout_secs: input.query_timeout_secs,
      charset: input.charset,
      environment: input.environment,
      ssh_config: ssh_config
        ? {
          host: ssh_config.host,
          port: ssh_config.port,
          username: ssh_config.username,
          private_key_path: ssh_config.private_key_path,
        }
        : null,
      pool_min: input.pool_min ?? existing?.pool_min ?? 1,
      pool_max: input.pool_max ?? existing?.pool_max ?? 5,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    state.profiles = existing
      ? state.profiles.map((p) => (p.id === id ? summary : p))
      : [...state.profiles, summary];
    return id;
  },

  delete_connection_profile: async (args): Promise<null> => {
    await delay();
    state.profiles = state.profiles.filter((p) => p.id !== String(args.profileId));
    return null;
  },

  test_connection: async (args): Promise<TestConnectionResult> => {
    const profile = args.profile as ConnectionProfile_Deserialize;
    refuseSsh(profile);
    const latency = profile.id === SLOW_PROFILE ? 1_480 : isRefused(profile) ? 9 : 38;
    await delay(latency + 200);
    if (isRefused(profile)) {
      // A failed test is a result, not an error: the dialog shows it inline.
      return {
        success: false,
        message: "Connection failed: error communicating with database: Connection refused (os error 111)",
        server_version: null,
        latency_ms: latency,
      };
    }
    const version = versionOf(profile.id);
    return { success: true, message: `Connected to MySQL ${version}`, server_version: version, latency_ms: latency };
  },

  connect: async (args): Promise<ConnectionInfo> => {
    const profileId = String(args.profileId);
    const profile = state.profiles.find((p) => p.id === profileId);
    if (!profile) return fail(`Not found: Connection profile not found: ${profileId}`);

    const preopened = profileId === SCENARIO_PROFILE ? scenarioConnection() : undefined;
    if (preopened) return preopened;

    refuseSsh(profile);
    await delay(profileId === SLOW_PROFILE ? 1_500 : 350);
    if (isRefused(profile)) {
      return fail(`Connection error: Could not connect "${profile.name}". ${refusedDetail(profile.host, profile.port)}`);
    }
    const info = openConnection(profile);
    // The checker's first report, so the tab's health dot fills in as it does
    // in the app. Not awaited: the connect answer should not wait on it.
    setTimeout(() => void emit("connection-health-event", healthy(info.id)), 50);
    return info;
  },

  disconnect: async (args): Promise<null> => {
    liveConnection(args.connectionId);
    await delay(60);
    state.connections.delete(String(args.connectionId));
    return null;
  },

  list_connections: (): ConnectionInfo[] => {
    scenarioConnection();
    return [...state.connections.values()];
  },

  // Null for an id the checker has never seen, as the backend answers.
  connection_health: (args): ConnectionHealth | null =>
    state.connections.has(String(args.connectionId)) ? healthy(String(args.connectionId)) : null,

  ping_connection: async (args): Promise<ConnectionHealth> => {
    const conn = liveConnection(args.connectionId);
    await delay(latencyOf(conn.id) * 10);
    return healthy(conn.id);
  },

  startup_problems: (): StartupProblem[] => [],
};
