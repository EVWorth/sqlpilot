import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listenFn, apiMocks } = vi.hoisted(() => ({
  listenFn: vi.fn(),
  apiMocks: { answerAgentRequest: vi.fn() },
}));

vi.mock("../../lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  events: { agentRequest: { listen: listenFn } },
}));

vi.mock("../../lib/tauri-api", () => ({ api: apiMocks }));

import type { AgentRequest } from "../../lib/bindings";
import { useAgentStore } from "../../stores/agentStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { useAgentRequests } from "../useAgentRequests";

function Mounted() {
  useAgentRequests();
  return null;
}

/** Deliver one request to the listener the hook registered. */
async function deliver(request: AgentRequest) {
  const handler = listenFn.mock.calls[0][0] as (e: { payload: AgentRequest }) => void;
  handler({ payload: request });
  await waitFor(() => expect(true).toBe(true));
}

/** The JSON value sent back for a request, parsed. */
function answered(index = 0) {
  const [, value] = apiMocks.answerAgentRequest.mock.calls[index];
  return JSON.parse(value as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  listenFn.mockResolvedValue(() => {});
  apiMocks.answerAgentRequest.mockResolvedValue(null);

  useEditorStore.setState({
    tabs: [{
      id: "t1",
      title: "Untitled Query",
      content: "SELECT * FROM orders",
      isDirty: false,
      type: "query",
      connectionId: "live-1",
      database: "shop",
    }],
    activeTabId: "t1",
    editorInstance: null,
  });
  useConnectionStore.setState({
    activeConnections: [
      { id: "live-1", profile_id: "p1", name: "shop" },
    ] as never,
  });
  useResultStore.setState({ results: [], activeResultIndex: 0 });
  useAgentStore.setState({ proposal: null });
});

describe("useAgentRequests", () => {
  it("answers a question about the editor from what is there now", async () => {
    render(<Mounted />);
    await deliver({ id: "r1", kind: "editorContext" } as AgentRequest);

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    expect(answered()).toMatchObject({
      tab: "t1",
      sql: "SELECT * FROM orders",
      connection: "p1",
    });
  });

  it("says so when the active tab has no SQL in it", async () => {
    useEditorStore.setState({
      tabs: [{
        id: "t2",
        title: "🔧 Admin",
        content: "",
        isDirty: false,
        type: "admin",
        connectionId: "live-1",
      }],
      activeTabId: "t2",
    });
    render(<Mounted />);
    await deliver({ id: "r1", kind: "editorContext" } as AgentRequest);

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    const [, value, error] = apiMocks.answerAgentRequest.mock.calls[0];
    expect(value).toBeUndefined();
    expect(error).toContain("not a query tab");
  });

  it("answers null when nothing has been run", async () => {
    render(<Mounted />);
    await deliver({ id: "r1", kind: "resultContext" } as AgentRequest);

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    expect(answered()).toBeNull();
  });

  it("opens a draft in a new tab without touching the old one", async () => {
    render(<Mounted />);
    await deliver({
      id: "r1",
      kind: "openDraft",
      sql: "ALTER TABLE orders ADD INDEX (customer_id)",
      title: "Add the index",
      connection: "p1",
      database: "shop",
    } as AgentRequest);

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    const tabs = useEditorStore.getState().tabs;
    expect(tabs).toHaveLength(2);
    const draft = tabs.find((t) => t.id !== "t1")!;
    expect(draft.content).toBe("ALTER TABLE orders ADD INDEX (customer_id)");
    expect(draft.title).toBe("Add the index");
    // The tab it was working in is untouched.
    expect(tabs.find((t) => t.id === "t1")!.content).toBe("SELECT * FROM orders");
    expect(answered()).toBe(draft.id);
  });

  it("opens a draft even when the named connection is not connected", async () => {
    // The SQL is still worth putting in front of the user.
    render(<Mounted />);
    await deliver({
      id: "r1",
      kind: "openDraft",
      sql: "SELECT 1",
      title: null,
      connection: "p9",
      database: null,
    } as AgentRequest);

    await waitFor(() => expect(useEditorStore.getState().tabs).toHaveLength(2));
    const draft = useEditorStore.getState().tabs.find((t) => t.id !== "t1")!;
    expect(draft.connectionId).toBeUndefined();
  });

  it("shows a proposal instead of answering it", async () => {
    // The answer is the user's decision, and it has not been made yet.
    render(<Mounted />);
    await deliver({
      id: "r1",
      kind: "proposeEdit",
      tab: "t1",
      sql: "SELECT id FROM orders",
      rationale: "SELECT * reads every column",
    } as AgentRequest);

    await waitFor(() => expect(useAgentStore.getState().proposal).not.toBeNull());
    expect(useAgentStore.getState().proposal).toMatchObject({
      id: "r1",
      tabId: "t1",
      current: "SELECT * FROM orders",
      proposed: "SELECT id FROM orders",
      rationale: "SELECT * reads every column",
    });
    expect(apiMocks.answerAgentRequest).not.toHaveBeenCalled();
  });

  it("does not write to the tab while the user is deciding", async () => {
    render(<Mounted />);
    await deliver({
      id: "r1",
      kind: "proposeEdit",
      tab: "t1",
      sql: "DROP TABLE orders",
      rationale: "for a laugh",
    } as AgentRequest);

    await waitFor(() => expect(useAgentStore.getState().proposal).not.toBeNull());
    expect(useEditorStore.getState().tabs[0].content).toBe("SELECT * FROM orders");
  });

  it("refuses a proposal for a tab that has been closed", async () => {
    render(<Mounted />);
    await deliver({
      id: "r1",
      kind: "proposeEdit",
      tab: "gone",
      sql: "SELECT 1",
      rationale: "why",
    } as AgentRequest);

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    const [, , error] = apiMocks.answerAgentRequest.mock.calls[0];
    expect(error).toContain("get_editor_context");
    expect(useAgentStore.getState().proposal).toBeNull();
  });

  it("leaves lastError to the backend", async () => {
    // It reads the history store, so it survives the tab being closed.
    render(<Mounted />);
    await deliver({ id: "r1", kind: "lastError" } as AgentRequest);
    expect(apiMocks.answerAgentRequest).not.toHaveBeenCalled();
  });
});
