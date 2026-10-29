// Agents: what is shared, the endpoint, and an in-app session that talks back.
//
// Both harness states are on show: Claude reports installed and answers;
// Copilot reports installed too (the status has no "signed in" field — the
// real app only learns that when a prompt fails) and fails its first turn
// with the not-signed-in message, so that path can be looked at as well.
//
// A turn is a script of events played over a few seconds. A message that
// mentions "delete" or "update" asks the harness's own permission first and,
// if allowed, then SQLPilot's approval — the two gates of AI_INTEGRATION §2.

import { emit } from "@tauri-apps/api/event";
import type {
  AgentAsk,
  AgentConnection_Serialize,
  AgentEndpoint_Serialize,
  AgentRequest,
  AgentSessionEvent_Serialize,
  DataPosture,
  Harness,
  HarnessStatus_Serialize,
  PermissionOption,
  SessionEvent_Serialize,
  SetupTarget,
  StartedSession,
} from "../../../lib/bindings";
import { findTable, type MockTable } from "../dataset";
import { type Args, delay, fail, type Handlers } from "../router";
import { newId, state } from "../state";

// ---------------------------------------------------------------- sharing

interface Grant {
  posture: DataPosture;
  databases: string[] | null;
  redact: string[];
  ddlUnlocked: boolean;
}

/**
 * Local dev shared in full, production schema-only, staging not at all. The
 * read-write production of `?mock=servers` is shared with writes, so the
 * production DDL checkbox has a connection to be about.
 */
const grants = new Map<string, Grant>([
  ["profile-local", { posture: "full", databases: null, redact: [], ddlUnlocked: false }],
  ["profile-prod", { posture: "schema-only", databases: ["shop"], redact: ["email", "*_token"], ddlUnlocked: false }],
  ["profile-prod-rw", { posture: "full", databases: ["shop"], redact: ["email"], ddlUnlocked: false }],
]);

// ---------------------------------------------------------------- endpoint

const ENDPOINT_URL = "http://127.0.0.1:47311/mcp";
let running = true;
let tokenSerial = 1;

/** Plainly fake, so a screenshot never shows anything resembling a secret. */
const token = () => `mock-token-${String(tokenSerial).padStart(4, "0")}-not-a-secret`;

function endpoint(): AgentEndpoint_Serialize {
  return running ? { running, url: ENDPOINT_URL, token: token() } : { running, url: null, token: null };
}

function setupText(target: SetupTarget): string {
  const header = `--header "Authorization: Bearer ${token()}"`;
  switch (target) {
    case "claude-code":
      return `claude mcp add --transport http sqlpilot ${ENDPOINT_URL} \\\n  ${header}\n`;
    case "copilot":
      return `copilot mcp add --transport http sqlpilot ${ENDPOINT_URL} \\\n  ${header}\n`;
    case "other":
      return JSON.stringify(
        {
          mcpServers: {
            sqlpilot: { type: "http", url: ENDPOINT_URL, headers: { Authorization: `Bearer ${token()}` } },
          },
        },
        null,
        2,
      );
  }
}

// ---------------------------------------------------------------- harnesses

const HARNESSES: (HarnessStatus_Serialize & { version: string })[] = [
  { harness: "claude-code", label: "Claude Agent", installed: true, version: "2.1.14", installHint: null },
  { harness: "copilot", label: "GitHub Copilot", installed: true, version: "1.0.75", installHint: null },
];

// ---------------------------------------------------------------- window requests

/** Requests waiting on `answer_agent_request`, by id. */
const waiting = new Map<string, (answer: { value: string | null; error: string | null }) => void>();
/** The approval dialog holds one at a time, so requests are sent in turn. */
let queue: Promise<unknown> = Promise.resolve();

function ask(question: AgentAsk): Promise<{ value: string | null; error: string | null }> {
  const asked = queue.then(
    () =>
      new Promise<{ value: string | null; error: string | null }>((resolve) => {
        const id = newId("agent-request");
        waiting.set(id, resolve);
        void emit("agent-request", { id, ...question } satisfies AgentRequest);
      }),
  );
  queue = asked;
  return asked;
}

const approved = (answer: { value: string | null; error: string | null }): boolean => {
  if (answer.error || !answer.value) return false;
  const parsed = JSON.parse(answer.value) as { approved?: boolean } | null;
  return parsed?.approved === true;
};

// ---------------------------------------------------------------- the data the agent "measures"

function count(table: MockTable, match: (row: Record<string, unknown>) => boolean): number {
  let n = 0;
  for (let i = 0; i < table.rowCount; i++) {
    const row = Object.fromEntries(table.columns.map((c) => [c.name, c.gen(i)]));
    if (match(row)) n++;
  }
  return n;
}

const orders = findTable("shop", "orders");
const customers = findTable("shop", "customers");
const STATUSES = ["pending", "paid", "shipped", "delivered", "refunded"];

/** `SELECT status, COUNT(*) FROM shop.orders GROUP BY status`, from the fixture rows. */
const byStatus = () =>
  STATUSES
    .map((s) => [s, orders ? count(orders, (r) => r.status === s) : 0] as const)
    .sort((a, b) => b[1] - a[1]);

// ---------------------------------------------------------------- sessions

interface Turn {
  cancelled: boolean;
  /** The tool row on screen, so a cancel can mark it failed. */
  tool: string | null;
  /** Wakes a turn paused on a permission prompt or an approval. */
  wake: (() => void) | null;
}

interface Session {
  id: string;
  harness: Harness;
  turn: Turn | null;
  /** The permission prompt waiting for an answer, and where to deliver it. */
  permission: { id: string; answer: (option: string | null) => void } | null;
}

const sessions = new Map<string, Session>();
let demoRequestSent = false;

function live(id: unknown): Session {
  const s = sessions.get(String(id));
  if (!s) fail(`The agent session is not running: ${String(id)}`);
  return s;
}

function send(session: Session, event: SessionEvent_Serialize): void {
  void emit("agent-session-event", { session: session.id, event } satisfies AgentSessionEvent_Serialize);
}

/** Unwinds a cancelled turn; caught in `play`, never seen by the router. */
class Cancelled extends Error {}

/** Wait, unless the turn is cancelled first. */
async function step(turn: Turn, ms: number): Promise<void> {
  await delay(ms);
  if (turn.cancelled) throw new Cancelled();
}

/** Stream text in a few pieces, the way a model's deltas arrive. */
async function say(session: Session, turn: Turn, text: string, pieces = 5): Promise<void> {
  const size = Math.ceil(text.length / pieces);
  for (let i = 0; i < text.length; i += size) {
    await step(turn, 110);
    send(session, { type: "text", delta: text.slice(i, i + size) });
  }
}

async function readTurn(session: Session, turn: Turn): Promise<void> {
  const plan = (done: number) =>
    send(session, {
      type: "plan",
      entries: ["Find the orders table", "Count orders by status", "Summarise"].map((content, i) => ({
        content,
        status: i < done ? "completed" : i === done ? "in_progress" : "pending",
      })),
    });

  const counts = byStatus();
  await step(turn, 250);
  send(session, { type: "thought", delta: "They want a breakdown of orders. " });
  await step(turn, 150);
  send(session, { type: "thought", delta: "shop.orders has a status enum, so one GROUP BY answers it." });
  plan(1);
  await say(session, turn, "Let me count the orders in each status on Local dev.\n", 3);

  const tool = newId("tool");
  turn.tool = tool;
  send(session, { type: "toolStarted", id: tool, title: "run_select on Local dev", kind: "execute" });
  await step(turn, 900);
  send(session, {
    type: "toolFinished",
    id: tool,
    status: "completed",
    detail: `SELECT status, COUNT(*) FROM shop.orders GROUP BY status — ${counts.length} rows`,
  });
  turn.tool = null;
  plan(2);

  const lines = counts.map(([s, n]) => `- ${s}: ${n.toLocaleString("en-US")}`).join("\n");
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  await say(
    session,
    turn,
    `\nHere is how the ${total.toLocaleString("en-US")} orders in shop.orders break down:\n\n${lines}\n\n`
      + "The statuses are spread almost evenly, which is unusual for real traffic — worth checking whether this is seeded data.",
    8,
  );
  plan(3);
  send(session, { type: "turnEnded", reason: "end_turn" });
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { id: "allow-once", label: "Allow once", kind: "allow_once" },
  { id: "allow-always", label: "Always allow", kind: "allow_always" },
  { id: "reject-once", label: "Reject", kind: "reject_once" },
];

async function writeTurn(session: Session, turn: Turn, verb: "delete" | "update"): Promise<void> {
  const write = verb === "delete"
    ? {
      sql: "DELETE FROM shop.orders WHERE status = 'refunded'",
      rows: orders ? count(orders, (r) => r.status === "refunded") : 0,
      done: "deleted",
    }
    : {
      sql: "UPDATE shop.orders SET status = 'delivered'\nWHERE status = 'shipped' AND placed_at < '2026-09-01'",
      rows: orders ? count(orders, (r) => r.status === "shipped" && String(r.placed_at) < "2026-09-01") : 0,
      done: "updated",
    };

  await step(turn, 250);
  send(session, { type: "thought", delta: `This is a ${verb}, so it changes data and has to be approved.` });
  await say(session, turn, "That changes data, so I need your go-ahead before I run it.\n", 3);

  await step(turn, 200);
  const request = newId("permission");
  const option = await new Promise<string | null>((resolve) => {
    session.permission = { id: request, answer: resolve };
    turn.wake = () => resolve(null);
    send(session, {
      type: "permissionRequested",
      id: request,
      title: `Run run_write on Local dev: ${write.sql.split("\n")[0]}`,
      detail: write.sql,
      options: PERMISSION_OPTIONS,
    });
  });
  session.permission = null;
  if (turn.cancelled) throw new Cancelled();

  if (option === null) {
    // Dismissed without a decision: the agent stops rather than looking for
    // another way round, which is what the protocol asks of it.
    send(session, { type: "turnEnded", reason: "cancelled" });
    return;
  }
  if (!option.startsWith("allow")) {
    await say(session, turn, `Understood, I won't run it. Here it is if you want it later:\n\n${write.sql}`, 4);
    send(session, { type: "turnEnded", reason: "end_turn" });
    return;
  }

  const tool = newId("tool");
  turn.tool = tool;
  send(session, { type: "toolStarted", id: tool, title: "run_write on Local dev", kind: "edit" });
  await step(turn, 500);
  // SQLPilot's own question, which no harness setting can skip.
  const answer = await ask({
    kind: "approve",
    connection: "Local dev",
    environment: "development",
    database: "shop",
    sql: write.sql,
    rowsAffected: write.rows,
    change: "write",
    session: session.id,
    client: null,
    reason: verb === "delete" ? "Clearing out refunded orders, as asked." : "Marking old shipments as delivered.",
  });
  if (turn.cancelled) throw new Cancelled();
  const ok = approved(answer);
  send(session, {
    type: "toolFinished",
    id: tool,
    status: ok ? "completed" : "failed",
    detail: ok
      ? `${write.rows.toLocaleString("en-US")} rows ${write.done}, committed`
      : "Discarded in SQLPilot; nothing changed",
  });
  turn.tool = null;
  await say(
    session,
    turn,
    ok
      ? `Done: ${write.rows.toLocaleString("en-US")} rows ${write.done} in shop.orders.`
      : "You discarded it in SQLPilot, so nothing changed.",
    3,
  );
  send(session, { type: "turnEnded", reason: "end_turn" });
}

async function play(session: Session, text: string): Promise<void> {
  const turn: Turn = { cancelled: false, tool: null, wake: null };
  session.turn = turn;
  try {
    if (session.harness === "copilot") {
      await step(turn, 400);
      send(session, {
        type: "failed",
        message:
          "GitHub Copilot is not signed in. Run `copilot` in a terminal, sign in with /login, then start a new session.",
      });
      return;
    }
    const verb = /\b(delete|update)\b/i.exec(text)?.[1]?.toLowerCase() as "delete" | "update" | undefined;
    await (verb ? writeTurn(session, turn, verb) : readTurn(session, turn));
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
  } finally {
    if (session.turn === turn) session.turn = null;
  }
}

/** Shown a few seconds into the first session, as if from a harness on the endpoint. */
function sendDemoRequest(): void {
  if (demoRequestSent) return;
  demoRequestSent = true;
  const inactive = customers ? count(customers, (r) => r.is_active === 0) : 0;
  setTimeout(() => {
    void ask({
      kind: "approve",
      connection: "Local dev",
      environment: "development",
      database: "shop",
      sql: "DELETE FROM shop.customers WHERE is_active = 0",
      rowsAffected: inactive,
      change: "write",
      session: null,
      client: "claude-code",
      reason: "Removing customers marked inactive before the export.",
    });
  }, 6000);
}

// ---------------------------------------------------------------- handlers

export const agentHandlers: Handlers = {
  list_agent_connections: async (): Promise<AgentConnection_Serialize[]> => {
    await delay(80);
    const connected = new Set([...state.connections.values()].map((c) => c.profile_id));
    return state.profiles.map((p) => {
      const grant = grants.get(p.id);
      return {
        connectionId: p.id,
        name: p.name,
        environment: p.environment ?? "unknown",
        readOnly: p.read_only,
        connected: connected.has(p.id),
        posture: grant?.posture ?? null,
        databases: grant?.databases ?? null,
        redact: grant?.redact ?? [],
        ddlUnlocked: grant?.ddlUnlocked ?? false,
      };
    });
  },

  share_connection_with_agents: ({ connectionId, posture, databases, redact }: Args) => {
    const id = String(connectionId);
    const list = (databases as string[] | null) ?? null;
    grants.set(id, {
      posture: posture as DataPosture,
      // An empty list is "every database", not "none", as in the backend.
      databases: list && list.length > 0 ? list : null,
      redact: ((redact as string[] | null) ?? []).map((p) => p.trim()).filter(Boolean),
      // An unlock survives a change of terms; only revoking clears it.
      ddlUnlocked: grants.get(id)?.ddlUnlocked ?? false,
    });
    return null;
  },

  revoke_agent_connection: ({ connectionId }: Args) => {
    grants.delete(String(connectionId));
    return null;
  },

  unlock_agent_ddl: ({ connectionId, unlocked }: Args) => {
    const grant = grants.get(String(connectionId));
    if (grant) grant.ddlUnlocked = Boolean(unlocked);
    return null;
  },

  agent_endpoint_status: () => endpoint(),

  start_agent_endpoint: async () => {
    await delay(150);
    running = true;
    return endpoint();
  },

  stop_agent_endpoint: () => {
    running = false;
    return endpoint();
  },

  rotate_agent_token: async () => {
    await delay(150);
    tokenSerial++;
    return endpoint();
  },

  agent_harness_setup: ({ harness }: Args) => {
    if (!running) fail("The agent endpoint is not running, so there is nothing to point a harness at yet.");
    return setupText(harness as SetupTarget);
  },

  // Unknown ids are ignored, as in the backend: the request may have timed out
  // a moment before the user answered.
  answer_agent_request: ({ id, value, error }: Args) => {
    const resolve = waiting.get(String(id));
    waiting.delete(String(id));
    resolve?.({ value: (value as string | null) ?? null, error: (error as string | null) ?? null });
    return null;
  },

  list_harnesses: async (): Promise<HarnessStatus_Serialize[]> => {
    await delay(200);
    return HARNESSES;
  },

  start_agent_session: async ({ harness }: Args): Promise<StartedSession> => {
    const status = HARNESSES.find((h) => h.harness === harness) ?? fail(`Unknown harness: ${String(harness)}`);
    // Starting a harness takes a moment; long enough to see "Starting…".
    await delay(900);
    running = true;
    const session: Session = { id: newId("session"), harness: status.harness, turn: null, permission: null };
    sessions.set(session.id, session);
    // After the reply, so the store knows the id before the event arrives.
    setTimeout(() => send(session, { type: "started", session: `mock-${status.harness}-${session.id}` }), 50);
    sendDemoRequest();
    return { session: session.id, agent: status.label, version: status.version, toolsAvailable: true };
  },

  send_agent_message: ({ session: id, text }: Args) => {
    const session = live(id);
    if (session.turn) fail("The agent is still answering. Wait for it, or stop the turn.");
    void play(session, String(text ?? ""));
    return null;
  },

  cancel_agent_turn: ({ session: id }: Args) => {
    const session = live(id);
    const turn = session.turn;
    if (!turn) return null;
    turn.cancelled = true;
    turn.wake?.();
    session.permission = null;
    session.turn = null;
    if (turn.tool) {
      send(session, {
        type: "toolFinished",
        id: turn.tool,
        status: "failed",
        detail: "Cancelled; the query was killed",
      });
    }
    send(session, { type: "turnEnded", reason: "cancelled" });
    return null;
  },

  answer_agent_permission: ({ session: id, request, option }: Args) => {
    const session = live(id);
    if (session.permission?.id === String(request)) {
      session.permission.answer((option as string | null) ?? null);
    }
    return null;
  },

  stop_agent_session: ({ session: id }: Args) => {
    const session = sessions.get(String(id));
    if (session?.turn) {
      session.turn.cancelled = true;
      session.turn.wake?.();
    }
    sessions.delete(String(id));
    return null;
  },
};
