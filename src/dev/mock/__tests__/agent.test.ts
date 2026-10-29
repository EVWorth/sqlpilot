import { listen } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRequest,
  AgentSessionEvent_Serialize,
  HarnessStatus_Serialize,
  StartedSession,
} from "../../../lib/bindings";
import { call, install, rejection, settle } from "./helpers";

interface Harnessed {
  session: string;
  requests: AgentRequest[];
  events: AgentSessionEvent_Serialize["event"][];
}

async function start(search = "?mock=connected"): Promise<Harnessed & StartedSession> {
  install(search);
  vi.useFakeTimers();
  const requests: AgentRequest[] = [];
  const events: AgentSessionEvent_Serialize["event"][] = [];
  await listen<AgentRequest>("agent-request", (e) => requests.push(e.payload));
  await listen<AgentSessionEvent_Serialize>("agent-session-event", (e) => events.push(e.payload.event));
  const started = await settle(call<StartedSession>("start_agent_session", { harness: "claude-code" }), 1_000);
  return { ...started, requests, events };
}

/** Send a message, allow the harness permission if asked, and run until SQLPilot is asked. */
async function turn(h: Harnessed, text: string): Promise<AgentRequest[]> {
  const before = h.requests.length;
  await call("send_agent_message", { session: h.session, text });
  await vi.advanceTimersByTimeAsync(3_000);
  const permission = h.events.find((e) => e.type === "permissionRequested");
  if (permission?.type === "permissionRequested") {
    await call("answer_agent_permission", { session: h.session, request: permission.id, option: "allow-once" });
    await vi.advanceTimersByTimeAsync(2_000);
  }
  return h.requests.slice(before).filter((r) =>
    r.kind !== "approve" || r.session !== null || r.client !== "claude-code"
  );
}

const answer = (id: string, value: unknown) => call("answer_agent_request", { id, value: JSON.stringify(value) });

describe("agent scenarios", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["delete the refunded orders", "Local dev", "development", "write"],
    ["clean up production", "Production (read-write)", "production", "write"],
    ["fix the staging customers", "Staging", "staging", "write"],
    ["add an index on placed_at", "Local dev", "development", "schema"],
    ["add an index on production", "Production (read-write)", "production", "schema"],
  ])("'%s' asks to approve a change on %s", async (text, connection, environment, change) => {
    const h = await start();
    const [request] = await turn(h, text);
    expect(request).toMatchObject({ kind: "approve", connection, environment, change, session: h.session });
    if (request.kind === "approve") expect(request.rowsAffected === null).toBe(change === "schema");
    await answer(request.id, { approved: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.events.at(-1)).toEqual({ type: "turnEnded", reason: "end_turn" });
  });

  it("sends two approvals at once", async () => {
    const h = await start();
    const requests = await turn(h, "do both at once");
    expect(requests.map((r) => r.kind === "approve" && r.connection)).toEqual(["Local dev", "Staging"]);
    if (requests[1].kind === "approve") expect(requests[1]).toMatchObject({ session: null, client: "copilot" });
  });

  it("proposes an edit to the active tab", async () => {
    const h = await start();
    const [request] = await turn(h, "rewrite my query");
    expect(request).toMatchObject({ kind: "proposeEdit", tab: null });
    await answer(request.id, { accepted: true, edited: false });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.events).toContainEqual(expect.objectContaining({ type: "toolFinished", detail: "Accepted into the tab" }));
  });

  it("opens a draft", async () => {
    const h = await start();
    const [request] = await turn(h, "open a draft for customers by city");
    expect(request).toMatchObject({ kind: "openDraft", title: "Customers by city", connection: "Local dev" });
  });

  it("agent=uninstalled reports every harness missing, with its install hint", async () => {
    install("?mock&agent=uninstalled");
    vi.useFakeTimers();
    const harnesses = await settle(call<HarnessStatus_Serialize[]>("list_harnesses"));
    expect(harnesses.every((h) => !h.installed && h.installHint?.startsWith("npm install -g"))).toBe(true);
    expect(await settle(rejection("start_agent_session", { harness: "claude-code" }))).toMatch(/is not installed/);
  });

  it("agent=no-tools starts a session without the database tools", async () => {
    expect((await start("?mock&agent=no-tools")).toolsAvailable).toBe(false);
    expect((await start("?mock")).toolsAvailable).toBe(true);
  });
});
