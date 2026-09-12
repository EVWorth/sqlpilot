import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    listHarnesses: vi.fn(),
    startAgentSession: vi.fn(),
    sendAgentMessage: vi.fn(),
    cancelAgentTurn: vi.fn(),
    stopAgentSession: vi.fn(),
    answerAgentPermission: vi.fn(),
  },
}));

vi.mock("../../lib/tauri-api", () => ({ api: apiMocks }));

import type { SessionEvent } from "../../lib/bindings";
import { useAgentSessionStore } from "../agentSessionStore";

const started = {
  session: "s1",
  agent: "Copilot",
  version: "1.0.75",
  toolsAvailable: true,
};

/** Deliver an event as the listener would. */
function arrive(event: SessionEvent, session = "s1") {
  useAgentSessionStore.getState().receive({ session, event });
}

const transcript = () => useAgentSessionStore.getState().transcript;

beforeEach(() => {
  vi.clearAllMocks();
  useAgentSessionStore.setState({
    harnesses: [],
    session: null,
    agent: null,
    toolsAvailable: false,
    thinking: false,
    transcript: [],
    error: null,
    starting: false,
  });
  apiMocks.listHarnesses.mockResolvedValue([
    { harness: "copilot", label: "GitHub Copilot", installed: true, version: "1.0.75" },
    {
      harness: "claude-code",
      label: "Claude Agent",
      installed: false,
      installHint: "npm install -g @anthropic-ai/claude-code",
    },
  ]);
  apiMocks.startAgentSession.mockResolvedValue(started);
  apiMocks.sendAgentMessage.mockResolvedValue(null);
  apiMocks.cancelAgentTurn.mockResolvedValue(null);
  apiMocks.stopAgentSession.mockResolvedValue(null);
  apiMocks.answerAgentPermission.mockResolvedValue(null);
});

describe("starting", () => {
  it("reports which harnesses are installed", async () => {
    await useAgentSessionStore.getState().findHarnesses();
    expect(useAgentSessionStore.getState().harnesses).toHaveLength(2);
  });

  it("records what answered, so the header can say", async () => {
    await useAgentSessionStore.getState().start("copilot");
    const state = useAgentSessionStore.getState();
    expect(state.session).toBe("s1");
    expect(state.agent).toBe("Copilot 1.0.75");
    expect(state.toolsAvailable).toBe(true);
    expect(state.starting).toBe(false);
  });

  it("starts with an empty transcript", async () => {
    // The old one belonged to a process that is gone.
    useAgentSessionStore.setState({ transcript: [{ kind: "agent", text: "old" }] });
    await useAgentSessionStore.getState().start("copilot");
    expect(transcript()).toEqual([]);
  });

  it("keeps a failure to start visible", async () => {
    apiMocks.startAgentSession.mockRejectedValue(
      new Error("Could not start Claude Agent: not found. Install it with `npm install -g …`."),
    );
    await useAgentSessionStore.getState().start("claude-code");
    expect(useAgentSessionStore.getState().error).toContain("npm install");
    expect(useAgentSessionStore.getState().starting).toBe(false);
  });

  it("says when a session has no database tools", async () => {
    // Otherwise the agent just looks oddly blind.
    apiMocks.startAgentSession.mockResolvedValue({ ...started, toolsAvailable: false });
    await useAgentSessionStore.getState().start("copilot");
    expect(useAgentSessionStore.getState().toolsAvailable).toBe(false);
  });
});

describe("sending", () => {
  beforeEach(async () => {
    await useAgentSessionStore.getState().start("copilot");
  });

  it("shows the user's message at once", async () => {
    // Waiting for the round trip to echo it back reads as a dropped keystroke.
    await useAgentSessionStore.getState().send("what is in this database?");
    expect(transcript()[0]).toEqual({ kind: "user", text: "what is in this database?" });
    expect(apiMocks.sendAgentMessage).toHaveBeenCalledWith("s1", "what is in this database?");
  });

  it("ignores an empty message", async () => {
    await useAgentSessionStore.getState().send("   ");
    expect(apiMocks.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("is thinking until the turn ends", async () => {
    await useAgentSessionStore.getState().send("hi");
    expect(useAgentSessionStore.getState().thinking).toBe(true);

    arrive({ type: "text", delta: "hello" });
    expect(useAgentSessionStore.getState().thinking).toBe(true);

    arrive({ type: "turnEnded", reason: "end_turn" });
    expect(useAgentSessionStore.getState().thinking).toBe(false);
  });

  it("stops thinking when the session fails", async () => {
    // Otherwise the spinner runs forever on a dead agent.
    await useAgentSessionStore.getState().send("hi");
    arrive({ type: "failed", message: "The agent stopped." });
    expect(useAgentSessionStore.getState().thinking).toBe(false);
  });

  it("stops thinking if the send itself fails", async () => {
    apiMocks.sendAgentMessage.mockRejectedValue(new Error("not running"));
    await useAgentSessionStore.getState().send("hi");
    expect(useAgentSessionStore.getState().thinking).toBe(false);
    expect(useAgentSessionStore.getState().error).toContain("not running");
  });
});

describe("events", () => {
  beforeEach(async () => {
    await useAgentSessionStore.getState().start("copilot");
  });

  it("folds text into the transcript", () => {
    arrive({ type: "text", delta: "one " });
    arrive({ type: "text", delta: "two" });
    expect(transcript()).toEqual([{ kind: "agent", text: "one two" }]);
  });

  it("drops events from a session that is no longer the one on screen", () => {
    // A stopped session's last events must not be folded into the new one.
    arrive({ type: "text", delta: "from the old session" }, "s0");
    expect(transcript()).toEqual([]);
  });

  it("keeps a permission request until it is answered", async () => {
    arrive({
      type: "permissionRequested",
      id: "p1",
      title: "Run `ls`",
      detail: null,
      options: [{ id: "yes", label: "Allow", kind: "allow_once" }],
    });
    const asked = transcript()[0];
    expect(asked.kind).toBe("permission");
    expect(asked).not.toHaveProperty("answered", "yes");

    await useAgentSessionStore.getState().answer("p1", "yes");
    expect(transcript()[0]).toMatchObject({ answered: "yes" });
    expect(apiMocks.answerAgentPermission).toHaveBeenCalledWith("s1", "p1", "yes");
  });

  it("marks a permission answered before the round trip", async () => {
    // So a second click cannot send a second answer.
    arrive({
      type: "permissionRequested",
      id: "p1",
      title: "Run `ls`",
      detail: null,
      options: [{ id: "yes", label: "Allow", kind: "allow_once" }],
    });
    let resolve: () => void = () => {};
    apiMocks.answerAgentPermission.mockReturnValue(
      new Promise<null>((r) => {
        resolve = () => r(null);
      }),
    );

    const answering = useAgentSessionStore.getState().answer("p1", "yes");
    expect(transcript()[0]).toMatchObject({ answered: "yes" });
    resolve();
    await answering;
  });

  it("sends a dismissal as a dismissal", async () => {
    arrive({
      type: "permissionRequested",
      id: "p1",
      title: "Run `ls`",
      detail: null,
      options: [{ id: "yes", label: "Allow", kind: "allow_once" }],
    });
    await useAgentSessionStore.getState().answer("p1", undefined);
    expect(apiMocks.answerAgentPermission).toHaveBeenCalledWith("s1", "p1", undefined);
  });
});

describe("stopping", () => {
  beforeEach(async () => {
    await useAgentSessionStore.getState().start("copilot");
  });

  it("cancels the turn without ending the session", async () => {
    await useAgentSessionStore.getState().cancel();
    expect(apiMocks.cancelAgentTurn).toHaveBeenCalledWith("s1");
    expect(useAgentSessionStore.getState().session).toBe("s1");
  });

  it("ends the session", async () => {
    await useAgentSessionStore.getState().stop();
    expect(apiMocks.stopAgentSession).toHaveBeenCalledWith("s1");
    expect(useAgentSessionStore.getState().session).toBeNull();
    expect(useAgentSessionStore.getState().thinking).toBe(false);
  });

  it("forgets the session even when stopping it failed", async () => {
    // The process may already be gone; leaving the UI attached to it would
    // make the panel unusable until a restart.
    apiMocks.stopAgentSession.mockRejectedValue(new Error("already gone"));
    await useAgentSessionStore.getState().stop();
    expect(useAgentSessionStore.getState().session).toBeNull();
  });

  it("does nothing with no session", async () => {
    useAgentSessionStore.setState({ session: null });
    await useAgentSessionStore.getState().cancel();
    await useAgentSessionStore.getState().stop();
    expect(apiMocks.cancelAgentTurn).not.toHaveBeenCalled();
    expect(apiMocks.stopAgentSession).not.toHaveBeenCalled();
  });
});
