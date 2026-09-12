import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("../../../lib/tauri-api", () => ({ api: apiMocks }));

import { useAgentSessionStore } from "../../../stores/agentSessionStore";
import { AgentPanel } from "../AgentPanel";

const copilot = {
  harness: "copilot" as const,
  label: "GitHub Copilot",
  installed: true,
  version: "1.0.75",
};
const claude = {
  harness: "claude-code" as const,
  label: "Claude Agent",
  installed: false,
  installHint: "npm install -g @anthropic-ai/claude-code",
};

const running = {
  session: "s1",
  agent: "Copilot 1.0.75",
  toolsAvailable: true,
  harnesses: [copilot],
};

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
  apiMocks.listHarnesses.mockResolvedValue([copilot, claude]);
  apiMocks.startAgentSession.mockResolvedValue({
    session: "s1",
    agent: "Copilot",
    version: "1.0.75",
    toolsAvailable: true,
  });
  apiMocks.sendAgentMessage.mockResolvedValue(null);
  apiMocks.cancelAgentTurn.mockResolvedValue(null);
  apiMocks.stopAgentSession.mockResolvedValue(null);
  apiMocks.answerAgentPermission.mockResolvedValue(null);
});

const open = () => render(<AgentPanel onClose={() => {}} />);

describe("before a session", () => {
  it("offers to start the harness that is installed", async () => {
    open();
    expect(await screen.findByRole("button", { name: /Start GitHub Copilot/ })).toBeTruthy();
    // Not the one that is missing — a button that fails is worse than none.
    expect(screen.queryByRole("button", { name: /Start Claude Agent/ })).toBeNull();
  });

  it("says SQLPilot does not sign in for you", async () => {
    // The whole BYOH promise, where someone would look for it.
    open();
    expect(await screen.findByText(/never signs in for you/)).toBeTruthy();
  });

  it("shows how to install one when none is there", async () => {
    apiMocks.listHarnesses.mockResolvedValue([claude]);
    open();
    expect(await screen.findByText("npm install -g @anthropic-ai/claude-code")).toBeTruthy();
  });

  it("starts a session when asked", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start GitHub Copilot/ }));
    await waitFor(() => expect(apiMocks.startAgentSession).toHaveBeenCalledWith("copilot"));
  });
});

describe("during a session", () => {
  beforeEach(() => useAgentSessionStore.setState(running));

  it("names what is answering", () => {
    // "Which model am I talking to" is the harness's answer, not ours.
    open();
    expect(screen.getByText("Copilot 1.0.75")).toBeTruthy();
  });

  it("sends what the user typed", async () => {
    open();
    const box = screen.getByLabelText("Message the agent");
    fireEvent.change(box, { target: { value: "what is in this database?" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));

    await waitFor(() => expect(apiMocks.sendAgentMessage).toHaveBeenCalledWith("s1", "what is in this database?"));
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("sends on Enter and breaks the line on Shift+Enter", async () => {
    open();
    const box = screen.getByLabelText("Message the agent");

    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(apiMocks.sendAgentMessage).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(apiMocks.sendAgentMessage).toHaveBeenCalled());
  });

  it("will not send nothing", () => {
    open();
    fireEvent.change(screen.getByLabelText("Message the agent"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: /Send/ })).toHaveProperty("disabled", true);
  });

  it("offers to stop a turn in progress, instead of sending another", () => {
    useAgentSessionStore.setState({ ...running, thinking: true });
    open();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
  });

  it("cancels the turn without ending the session", async () => {
    useAgentSessionStore.setState({ ...running, thinking: true });
    open();
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(apiMocks.cancelAgentTurn).toHaveBeenCalledWith("s1"));
  });

  it("ends the session on End", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    await waitFor(() => expect(apiMocks.stopAgentSession).toHaveBeenCalledWith("s1"));
  });

  it("says where writes are approved", () => {
    // The harness's own permissions are not the last word, and the panel says
    // so where the user is about to type.
    open();
    expect(screen.getByText(/approved in this window/)).toBeTruthy();
  });

  it("warns when the agent has no database tools", () => {
    useAgentSessionStore.setState({ ...running, toolsAvailable: false });
    open();
    expect(screen.getByText(/cannot see your databases/)).toBeTruthy();
  });
});

describe("the transcript", () => {
  beforeEach(() => useAgentSessionStore.setState(running));

  it("shows what the agent said", () => {
    useAgentSessionStore.setState({
      transcript: [
        { kind: "user", text: "hello" },
        { kind: "agent", text: "hi there" },
      ],
    });
    open();
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("hi there")).toBeTruthy();
  });

  it("keeps reasoning collapsed until asked for", () => {
    // It is long, and it is not the answer.
    useAgentSessionStore.setState({
      transcript: [{ kind: "thought", text: "weighing it up" }],
    });
    open();
    expect(screen.queryByText("weighing it up")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));
    expect(screen.getByText("weighing it up")).toBeTruthy();
  });

  it("shows what the agent is doing", () => {
    useAgentSessionStore.setState({
      transcript: [{
        kind: "tool",
        id: "t1",
        title: "run_select on shop",
        toolKind: "execute",
        status: "running",
      }],
    });
    open();
    expect(screen.getByText("run_select on shop")).toBeTruthy();
  });

  it("shows a plan with its progress", () => {
    useAgentSessionStore.setState({
      transcript: [{
        kind: "plan",
        entries: [
          { content: "Read the schema", status: "completed" },
          { content: "Write the migration", status: "in_progress" },
        ],
      }],
    });
    open();
    expect(screen.getByText("Read the schema")).toBeTruthy();
    expect(screen.getByText("Write the migration")).toBeTruthy();
  });

  it("asks the user about a permission, in this window", async () => {
    useAgentSessionStore.setState({
      transcript: [{
        kind: "permission",
        id: "p1",
        title: "Run `rm -rf build`",
        options: [
          { id: "yes", label: "Allow once", kind: "allow_once" },
          { id: "no", label: "Reject", kind: "reject_once" },
        ],
      }],
    });
    open();
    expect(screen.getByText("Run `rm -rf build`")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(apiMocks.answerAgentPermission).toHaveBeenCalledWith("s1", "p1", "yes"));
  });

  it("stops offering buttons once a permission is answered", () => {
    useAgentSessionStore.setState({
      transcript: [{
        kind: "permission",
        id: "p1",
        title: "Run `ls`",
        answered: "yes",
        options: [{ id: "yes", label: "Allow once", kind: "allow_once" }],
      }],
    });
    open();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.getByText("Allow once")).toBeTruthy();
  });

  it("shows a note when something went wrong", () => {
    useAgentSessionStore.setState({
      transcript: [{ kind: "note", text: "The agent stopped." }],
    });
    open();
    expect(screen.getByText("The agent stopped.")).toBeTruthy();
  });
});
