import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMocks, diffValue } = vi.hoisted(() => ({
  apiMocks: { answerAgentRequest: vi.fn() },
  // What the modified side of the diff editor holds, which the test can change
  // to stand in for the user editing the proposal before accepting it.
  diffValue: { current: "" },
}));

vi.mock("../../../lib/tauri-api", () => ({ api: apiMocks }));

/**
 * Monaco does not render in jsdom, and this test is not about Monaco. The stub
 * keeps the one interaction that matters — reading back what is on the
 * modified side — and shows both texts so the test can assert the user is
 * seeing the change rather than being told about it.
 */
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (
    { original, modified, onMount }: {
      original: string;
      modified: string;
      onMount: (editor: unknown) => void;
    },
  ) => {
    diffValue.current = modified;
    onMount({
      getModifiedEditor: () => ({ getValue: () => diffValue.current }),
    });
    return (
      <div data-testid="diff">
        <pre data-testid="original">{original}</pre>
        <pre data-testid="modified">{modified}</pre>
      </div>
    );
  },
}));

import { useAgentStore } from "../../../stores/agentStore";
import { useEditorStore } from "../../../stores/editorStore";
import { ProposedEditDialog } from "../ProposedEditDialog";

const proposal = {
  id: "r1",
  tabId: "t1",
  tabTitle: "Untitled Query",
  current: "SELECT * FROM orders",
  proposed: "SELECT id FROM orders",
  rationale: "SELECT * reads every column",
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.answerAgentRequest.mockResolvedValue(null);
  useEditorStore.setState({
    tabs: [{
      id: "t1",
      title: "Untitled Query",
      content: "SELECT * FROM orders",
      isDirty: false,
      type: "query",
      connectionId: "live-1",
    }],
    activeTabId: "t1",
  });
  useAgentStore.setState({ proposal: null });
});

/** The decision sent back to the agent. */
function decision() {
  const [, value] = apiMocks.answerAgentRequest.mock.calls[0];
  return JSON.parse(value as string);
}

describe("ProposedEditDialog", () => {
  it("shows nothing when nothing has been proposed", () => {
    render(<ProposedEditDialog />);
    expect(screen.queryByTestId("diff")).toBeNull();
  });

  it("shows the change next to what is there, with the reason for it", () => {
    useAgentStore.setState({ proposal });
    render(<ProposedEditDialog />);

    expect(screen.getByTestId("original").textContent).toBe("SELECT * FROM orders");
    expect(screen.getByTestId("modified").textContent).toBe("SELECT id FROM orders");
    expect(screen.getByText("SELECT * reads every column")).toBeTruthy();
  });

  it("writes nothing until the user accepts", () => {
    useAgentStore.setState({ proposal });
    render(<ProposedEditDialog />);
    expect(useEditorStore.getState().tabs[0].content).toBe("SELECT * FROM orders");
  });

  it("accepting applies the change and tells the agent it was taken", async () => {
    useAgentStore.setState({ proposal });
    render(<ProposedEditDialog />);

    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    expect(useEditorStore.getState().tabs[0].content).toBe("SELECT id FROM orders");
    expect(decision()).toEqual({
      accepted: true,
      edited: false,
      sql: "SELECT id FROM orders",
    });
  });

  it("rejecting leaves the tab alone and says no", async () => {
    useAgentStore.setState({ proposal });
    render(<ProposedEditDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    expect(useEditorStore.getState().tabs[0].content).toBe("SELECT * FROM orders");
    expect(decision()).toMatchObject({ accepted: false, edited: false });
    expect(decision().sql).toBeUndefined();
  });

  it("reports an accepted-after-editing proposal as edited", async () => {
    // The clearest signal an agent gets that its answer was close but not
    // right, and a plain acceptance would throw it away.
    useAgentStore.setState({ proposal });
    render(<ProposedEditDialog />);
    diffValue.current = "SELECT id FROM orders LIMIT 10";

    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    expect(decision()).toEqual({
      accepted: true,
      edited: true,
      sql: "SELECT id FROM orders LIMIT 10",
    });
    expect(useEditorStore.getState().tabs[0].content).toBe("SELECT id FROM orders LIMIT 10");
  });

  it("closing it answers rather than leaving the agent waiting", async () => {
    useAgentStore.setState({ proposal });
    render(<ProposedEditDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    expect(useAgentStore.getState().proposal).toBeNull();
  });

  it("escape rejects, rather than dismissing silently", async () => {
    // A proposal that vanished without an answer leaves the agent waiting out
    // its deadline.
    useAgentStore.setState({ proposal });
    render(<ProposedEditDialog />);

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    expect(decision().accepted).toBe(false);
  });

  it("switches to the tab being changed", () => {
    // The diff should never be about something the user cannot see.
    useEditorStore.setState({
      tabs: [
        ...useEditorStore.getState().tabs,
        {
          id: "t2",
          title: "Other",
          content: "",
          isDirty: false,
          type: "query",
        },
      ],
      activeTabId: "t2",
    });
    useAgentStore.setState({ proposal });
    render(<ProposedEditDialog />);

    expect(useEditorStore.getState().activeTabId).toBe("t1");
  });

  it("says plainly that nothing is written without consent", () => {
    useAgentStore.setState({ proposal });
    render(<ProposedEditDialog />);
    expect(screen.getByText(/Nothing is written unless you accept/)).toBeTruthy();
  });

  it("answers only once however fast the buttons are clicked", async () => {
    useAgentStore.setState({ proposal });
    render(<ProposedEditDialog />);

    const accept = screen.getByRole("button", { name: /Accept/ });
    fireEvent.click(accept);
    fireEvent.click(accept);

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    expect(apiMocks.answerAgentRequest).toHaveBeenCalledTimes(1);
  });
});
