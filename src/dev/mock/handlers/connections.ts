// Connection profiles, connecting, and connection health.
//
// Three profiles behave differently on purpose, so every connect state can be
// looked at: "Staging" takes a second and a half (the connecting spinner),
// "MariaDB sandbox" is refused (the connect error), and "Production" is
// read-only (the query handlers refuse writes on it). The rest connect at
// once.
//
// `?mock=servers` adds the outcomes left: "Wrong password" is rejected by the
// server, "Unreachable" never answers and times out, "MariaDB 11" connects to
// a MariaDB, and "Production (read-write)" is production that takes writes.
// `?mock=lost` connects "Local dev" and then loses it: the health checks fail
// from a few seconds in, and keep failing.

import { emit } from "@tauri-apps/api/event";
import type {
  ConnectionHealth,
  ConnectionInfo,
  ConnectionProfile_Deserialize,
  ConnectionProfileSummary_Serialize,
  StartupProblem,
  TestConnectionResult,
} from "../../../lib/bindings";
import { SERVER_VERSION } from "../dataset";
import { delay, fail, type Handlers } from "../router";
import { liveConnection, newId, startsConnected, state } from "../state";

const SLOW_PROFILE = "profile-staging";
const SCENARIO_PROFILE = "profile-local";

/** What a profile's server is, for one the dataset does not list. */
const versionOf = (profileId: string): string => SERVER_VERSION[profileId] ?? "8.0.39";

/** The server named the way the backend's Test Connection names it. */
const productOf = (version: string): string => {
  const at = version.toLowerCase().indexOf("-mariadb");
  return at >= 0 ? `MariaDB ${version.slice(0, at).replace(/^5\.5\.5-/, "")}` : `MySQL ${version}`;
};

/** The address the `servers` scenario's wrong-password profile points at. */
const BAD_PASSWORD_HOST = "db.qa.example.internal";
/** And the one that never answers. */
const SILENT_HOST = "10.20.30.40";

/**
 * Whether connecting to this address is refused.
 *
 * Keyed on the address rather than only the profile id, so a profile created
 * in the dialog pointing at the same port fails the same way.
 */
function isRefused(p: { id: string; host: string; port: number }): boolean {
  return p.id === "profile-maria" || p.port === 0 || (["localhost", "127.0.0.1"].includes(p.host) && p.port === 3307);
}

// The driver's own text, with the hint the backend adds for a refused TCP
// connection (`diagnose_connect_error` in mas-core).
const refusedDetail = (host: string, port: number) =>
  `Nothing is listening on ${host}:${port}. The server is stopped, or it is listening on a different port. `
  + "(error communicating with database: Connection refused (os error 111))";

type Profile = Pick<ConnectionProfileSummary_Serialize, "id" | "host" | "port" | "username" | "connect_timeout_secs">;

/**
 * Why connecting to this profile fails, as `diagnose_connect_error` and
 * `probe_detail` in mas-core word it, and how long it takes to find out; or
 * undefined when it connects.
 */
function connectFailure(p: Profile): { detail: string; ms: number } | undefined {
  if (isRefused(p)) return { detail: refusedDetail(p.host, p.port), ms: 350 };
  if (p.id === "profile-bad-password" || p.host === BAD_PASSWORD_HOST) {
    return {
      detail: "The server is reachable and rejected the credentials. Check the username and password on the "
        + "profile, and that this user is allowed to connect from this machine. (error returned from database: "
        + `1045 (28000): Access denied for user '${p.username}'@'10.0.1.7' (using password: YES))`,
      ms: 450,
    };
  }
  if (p.id === "profile-timeout" || p.host === SILENT_HOST) {
    const secs = p.connect_timeout_secs ?? 10;
    // The pool's timeout, then the probe's: two full waits with no answer.
    return {
      detail: `${p.host}:${p.port} did not answer within ${secs}s. Either the address is wrong, the server is `
        + "not running, or a firewall is dropping the connection rather than refusing it.",
      ms: Math.min(secs, 5) * 2_000,
    };
  }
  return undefined;
}

/**
 * Refuse a port that is not a u16, as Tauri does before the command runs:
 * `port` is `u16` on the Rust profile, so 70000, -1 or 3306.5 fail to
 * deserialize and the call is rejected with serde's message. Port 0 is a u16
 * and gets through, as it does in the app; connecting to it is refused.
 */
function refuseBadPorts(cmd: string, p: ConnectionProfile_Deserialize): void {
  for (const value of [p.port, p.ssh_config?.port]) {
    if (value === undefined || (Number.isInteger(value) && value >= 0 && value <= 65_535)) continue;
    const what = Number.isInteger(value)
      ? `invalid value: integer \`${value}\``
      : `invalid type: floating point \`${value}\``;
    fail(`invalid args \`profile\` for command \`${cmd}\`: ${what}, expected u16`);
  }
}

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

/** What the checker reports for a connection whose server has gone. */
const unhealthy = (connectionId: string, failures: number): ConnectionHealth => ({
  connectionId,
  healthy: false,
  latencyMs: null,
  error: "Lost connection to MySQL server during query",
  consecutiveFailures: failures,
});

/** The health of a live connection now: down, or answering. */
const healthOf = (connectionId: string): ConnectionHealth => {
  const failures = state.down.get(connectionId);
  return failures === undefined ? healthy(connectionId) : unhealthy(connectionId, failures);
};

const report = (health: ConnectionHealth) => emit("connection-health-event", health).catch(() => {});

/** When the `lost` scenario's server goes, and how often it is tried after. */
export const LOST_AFTER_MS = 4_000;
export const RETRY_EVERY_MS = 3_000;

/**
 * Lose a connection's server: every check from now on fails, and is reported,
 * as the backend reports every check while a connection is down. Stops once
 * the connection is closed.
 */
function loseServer(connectionId: string): void {
  const check = () => {
    if (!state.connections.has(connectionId)) return;
    const failures = (state.down.get(connectionId) ?? 0) + 1;
    state.down.set(connectionId, failures);
    void report(unhealthy(connectionId, failures));
    setTimeout(check, RETRY_EVERY_MS);
  };
  setTimeout(check, LOST_AFTER_MS);
}

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
  if (!startsConnected(state.scenario)) return undefined;
  const existing = [...state.connections.values()].find((c) => c.profile_id === SCENARIO_PROFILE);
  if (existing) return existing;
  const profile = state.profiles.find((p) => p.id === SCENARIO_PROFILE);
  if (!profile) return undefined;
  const info = openConnection(profile);
  if (state.scenario === "lost") loseServer(info.id);
  return info;
}

export const connectionHandlers: Handlers = {
  // The OS keyring works, as it does on any desktop the app supports; the
  // warning for a missing one is a separate screen to review on purpose.
  keyring_available: () => true,
  list_connection_profiles: async (): Promise<ConnectionProfileSummary_Serialize[]> => {
    await delay(60);
    return state.profiles.map((p) => ({ ...p }));
  },

  save_connection_profile: async (args): Promise<string> => {
    const input = args.profile as ConnectionProfile_Deserialize;
    refuseBadPorts("save_connection_profile", input);
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
    refuseBadPorts("test_connection", profile);
    refuseSsh(profile);
    const failure = connectFailure(profile);
    const latency = profile.id === SLOW_PROFILE ? 1_480 : failure ? failure.ms : 38;
    await delay(latency + 200);
    if (failure) {
      // A failed test is a result, not an error: the dialog shows it inline.
      return {
        success: false,
        message: `Connection failed. ${failure.detail}`,
        server_version: null,
        latency_ms: latency,
      };
    }
    const version = versionOf(profile.id);
    return {
      success: true,
      message: `Connected to ${productOf(version)}`,
      server_version: version,
      latency_ms: latency,
    };
  },

  connect: async (args): Promise<ConnectionInfo> => {
    const profileId = String(args.profileId);
    const profile = state.profiles.find((p) => p.id === profileId);
    if (!profile) return fail(`Not found: Connection profile not found: ${profileId}`);

    const preopened = profileId === SCENARIO_PROFILE ? scenarioConnection() : undefined;
    if (preopened) return preopened;

    refuseSsh(profile);
    const failure = connectFailure(profile);
    await delay(profileId === SLOW_PROFILE ? 1_500 : failure ? failure.ms : 350);
    if (failure) return fail(`Connection error: Could not connect "${profile.name}". ${failure.detail}`);
    const info = openConnection(profile);
    // The checker's first report, so the tab's health dot fills in as it does
    // in the app. Not awaited: the connect answer should not wait on it, and
    // with no event bus (a unit test) there is nobody to tell.
    setTimeout(() => void report(healthy(info.id)), 50);
    return info;
  },

  disconnect: async (args): Promise<null> => {
    liveConnection(args.connectionId, { evenIfDown: true });
    await delay(60);
    state.connections.delete(String(args.connectionId));
    state.down.delete(String(args.connectionId));
    return null;
  },

  list_connections: (): ConnectionInfo[] => {
    scenarioConnection();
    return [...state.connections.values()];
  },

  // Null for an id the checker has never seen, as the backend answers.
  connection_health: (args): ConnectionHealth | null =>
    state.connections.has(String(args.connectionId)) ? healthOf(String(args.connectionId)) : null,

  // A ping of a server that has gone is one more failed check, not an error.
  ping_connection: async (args): Promise<ConnectionHealth> => {
    const conn = liveConnection(args.connectionId, { evenIfDown: true });
    const failures = state.down.get(conn.id);
    if (failures === undefined) {
      await delay(latencyOf(conn.id) * 10);
      return healthy(conn.id);
    }
    await delay(1_000);
    state.down.set(conn.id, failures + 1);
    return unhealthy(conn.id, failures + 1);
  },

  startup_problems: (): StartupProblem[] => [],
};
