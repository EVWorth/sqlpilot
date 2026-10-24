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
    failed: false,
    transcript: [],
    error: null,
    starting: null,
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

  it("labels only the harness being started", () => {
    // Two "Starting…" buttons read as two harnesses launching.
    useAgentSessionStore.setState({
      harnesses: [copilot, { ...claude, installed: true, version: "2.1.14" }],
      starting: "copilot",
    });
    apiMocks.listHarnesses.mockReturnValue(new Promise(() => {}));
    open();
    const buttons = screen.getAllByRole("button", { name: /Start|Starting/ });
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Starting GitHub Copilot…(1.0.75)",
      "Start Claude Agent(2.1.14)",
    ]);
    // The other stays unclickable: one session at a time.
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
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

  it("asks before ending a session in the middle of a turn", async () => {
    useAgentSessionStore.setState({ ...running, thinking: true });
    open();
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(screen.getByRole("dialog", { name: "End the session?" })).toBeTruthy();
    expect(apiMocks.stopAgentSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep working" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apiMocks.stopAgentSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "End" }));
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    await waitFor(() => expect(apiMocks.stopAgentSession).toHaveBeenCalledWith("s1"));
  });

  it("keeps the last transcript on screen after the session ends", async () => {
    useAgentSessionStore.setState({
      ...running,
      transcript: [{ kind: "user", text: "hello" }, { kind: "agent", text: "hi there" }],
    });
    open();
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(await screen.findByRole("separator", { name: "Session ended" })).toBeTruthy();
    expect(screen.getByText("hi there")).toBeTruthy();
    // And a new one is one click away.
    expect(screen.getByRole("button", { name: /Start GitHub Copilot/ })).toBeTruthy();
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

  it("shows the whole statement a tool ran, on request", () => {
    const sql = "SELECT status, COUNT(*) FROM shop.orders GROUP BY status — 5 rows";
    useAgentSessionStore.setState({
      transcript: [{
        kind: "tool",
        id: "t1",
        title: "run_select on Local dev",
        toolKind: "execute",
        status: "completed",
        detail: sql,
      }],
    });
    const { container } = open();
    const toggle = screen.getByRole("button", { name: "Show what the agent ran" });
    // Hovering is enough to read it; clicking shows it in full.
    expect(toggle.getAttribute("title")).toBe(sql);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("pre")).toBeNull();

    fireEvent.click(toggle);
    expect(container.querySelector("pre")?.textContent).toBe(sql);
    expect(screen.getByRole("button", { name: "Hide what the agent ran" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("renders the agent's lists and code rather than the markdown", () => {
    useAgentSessionStore.setState({
      transcript: [{ kind: "agent", text: "Counts:\n\n- paid: 1,939\n- shipped: 1,902\n\nUse `GROUP BY`." }],
    });
    const { container } = open();
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["paid: 1,939", "shipped: 1,902"]);
    expect(container.querySelector("code")?.textContent).toBe("GROUP BY");
    expect(screen.queryByText(/`/)).toBeNull();
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

  it("shows the whole request under a permission's title", () => {
    useAgentSessionStore.setState({
      transcript: [{
        kind: "permission",
        id: "p1",
        title: "Run run_write on Local dev: UPDATE shop.orders SET status = 'delivered'",
        detail: "UPDATE shop.orders SET status = 'delivered'\nWHERE status = 'shipped'",
        options: [
          { id: "once", label: "Allow once", kind: "allow_once" },
          { id: "always", label: "Always allow", kind: "allow_always" },
          { id: "no", label: "Reject", kind: "reject_once" },
        ],
      }],
    });
    open();
    expect(screen.getByText(/WHERE status = 'shipped'/)).toBeTruthy();
    // Only the one-off choice is styled as the primary action.
    expect(screen.getByRole("button", { name: "Allow once" }).className).toContain("bg-brand-600");
    expect(screen.getByRole("button", { name: "Always allow" }).className).not.toContain(
      "bg-brand-600",
    );
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

  it("shows a harness failure as an error and offers a new session", async () => {
    useAgentSessionStore.setState({
      failed: true,
      transcript: [
        { kind: "user", text: "hello" },
        {
          kind: "error",
          text: "GitHub Copilot is not signed in. Run `copilot` in a terminal, then start a new session.",
        },
      ],
    });
    const { container } = open();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("is not signed in");
    expect(alert.className).toContain("color-error");
    // The backticks are code, not literal punctuation.
    expect(alert.querySelector("code")?.textContent).toBe("copilot");
    expect(container.textContent).not.toContain("`");

    // Nothing sent now would get an answer.
    expect((screen.getByLabelText("Message the agent") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start a new session" }));
    await waitFor(() => expect(apiMocks.stopAgentSession).toHaveBeenCalledWith("s1"));
  });

  it("shows a note when something went wrong", () => {
    useAgentSessionStore.setState({
      transcript: [{ kind: "note", text: "The agent stopped." }],
    });
    open();
    expect(screen.getByText("The agent stopped.")).toBeTruthy();
  });
});
