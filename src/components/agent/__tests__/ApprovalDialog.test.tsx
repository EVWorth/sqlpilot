import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: { answerAgentRequest: vi.fn() },
}));

vi.mock("../../../lib/tauri-api", () => ({ api: apiMocks }));

import type { PendingApproval } from "../../../stores/agentStore";
import { useAgentStore } from "../../../stores/agentStore";
import { ApprovalDialog } from "../ApprovalDialog";

const write: PendingApproval = {
  id: "a1",
  connection: "shop",
  environment: "staging",
  database: "shop",
  sql: "UPDATE orders SET status = 'new' WHERE status = 'nwe'",
  rowsAffected: 4,
  change: "write",
  reason: "the import wrote the status back to front",
};

/** What was sent back to the agent. */
function decision() {
  const [, value] = apiMocks.answerAgentRequest.mock.calls[0];
  return JSON.parse(value as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.answerAgentRequest.mockResolvedValue(null);
  useAgentStore.setState({ approval: null, approvals: [] });
});

describe("ApprovalDialog", () => {
  it("shows nothing when nothing is waiting", () => {
    render(<ApprovalDialog />);
    expect(screen.queryByText(/wants to change/)).toBeNull();
  });

  it("shows the statement, where it would run, and what it did", () => {
    useAgentStore.setState({ approval: write });
    render(<ApprovalDialog />);

    expect(screen.getByText(write.sql)).toBeTruthy();
    expect(screen.getByText("shop")).toBeTruthy();
    expect(screen.getByText("Updates 4 rows.")).toBeTruthy();
  });

  it("says the row count prominently, with the verb, however small", () => {
    // 132 deleted rows is not small print.
    useAgentStore.setState({
      approval: { ...write, sql: "DELETE FROM shop.customers WHERE is_active = 0", rowsAffected: 132 },
    });
    render(<ApprovalDialog />);
    const rows = screen.getByTestId("approval-rows");
    expect(rows.textContent).toBe("Deletes 132 rows.");
    expect(rows.className).toContain("font-semibold");
  });

  it("names who asked, when the backend says", () => {
    useAgentStore.setState({ approval: { ...write, requester: "Claude Agent 2.1.14 (in-app session)" } });
    render(<ApprovalDialog />);
    expect(screen.getByTestId("approval-requester").textContent).toBe(
      "Asked by Claude Agent 2.1.14 (in-app session)",
    );
  });

  it("does not guess who asked when it is not known", () => {
    useAgentStore.setState({ approval: write });
    render(<ApprovalDialog />);
    expect(screen.queryByTestId("approval-requester")).toBeNull();
  });

  it("says the number is measured rather than guessed", () => {
    // The whole point of running it first. "Might affect some rows" is not a
    // question anybody can answer.
    useAgentStore.setState({ approval: write });
    render(<ApprovalDialog />);
    expect(screen.getByText(/not yet committed/)).toBeTruthy();
  });

  it("shows the agent's reason as the agent's claim", () => {
    useAgentStore.setState({ approval: write });
    render(<ApprovalDialog />);
    expect(screen.getByText(/The agent says: the import wrote the status back to front/))
      .toBeTruthy();
  });

  it("applies on approval", async () => {
    useAgentStore.setState({ approval: write });
    render(<ApprovalDialog />);

    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    expect(apiMocks.answerAgentRequest.mock.calls[0][0]).toBe("a1");
    expect(decision()).toEqual({ approved: true });
    expect(useAgentStore.getState().approval).toBeNull();
  });

  it("discards on rejection", async () => {
    useAgentStore.setState({ approval: write });
    render(<ApprovalDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    expect(decision()).toEqual({ approved: false });
  });

  it("escape rejects rather than dismissing", async () => {
    // A dialog that vanished without answering would leave the transaction
    // open until it timed out, and the agent waiting on it.
    useAgentStore.setState({ approval: write });
    render(<ApprovalDialog />);

    // Fired at the dialog rather than the window: the shared Modal takes focus
    // when it opens, so this is where a real Escape keypress arrives.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalled());
    expect(decision()).toEqual({ approved: false });
  });

  it("has no way to close without deciding", () => {
    // Deliberate: the two buttons are the only exits.
    useAgentStore.setState({ approval: write });
    render(<ApprovalDialog />);
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("queues a second request instead of swapping it in", async () => {
    const second: PendingApproval = { ...write, id: "a2", sql: "DELETE FROM orders", rowsAffected: 90 };
    const { showApproval } = useAgentStore.getState();
    showApproval(write);
    render(<ApprovalDialog />);
    showApproval(second);

    // Still the first statement, and it says another is waiting.
    expect(await screen.findByText(write.sql)).toBeTruthy();
    expect(screen.queryByText("DELETE FROM orders")).toBeNull();
    expect(screen.getByTestId("approval-position").textContent).toBe("1 of 2");

    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalledTimes(1));
    expect(apiMocks.answerAgentRequest.mock.calls[0][0]).toBe("a1");

    // Then the second, on its own, answerable separately.
    expect(await screen.findByText("DELETE FROM orders")).toBeTruthy();
    expect(screen.queryByTestId("approval-position")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalledTimes(2));
    expect(apiMocks.answerAgentRequest.mock.calls[1][0]).toBe("a2");
    expect(JSON.parse(apiMocks.answerAgentRequest.mock.calls[1][1] as string)).toEqual({
      approved: false,
    });
    expect(useAgentStore.getState().approval).toBeNull();
  });

  it("answers once however fast the button is clicked", async () => {
    useAgentStore.setState({ approval: write });
    render(<ApprovalDialog />);

    const apply = screen.getByRole("button", { name: /Apply/ });
    fireEvent.click(apply);
    fireEvent.click(apply);

    await waitFor(() => expect(apiMocks.answerAgentRequest).toHaveBeenCalledTimes(1));
  });

  it("marks production, because the same statement is a different decision there", () => {
    useAgentStore.setState({ approval: { ...write, environment: "production" } });
    render(<ApprovalDialog />);
    expect(screen.getByTestId("approval-environment").textContent).toBe("production");
  });

  it("draws attention to a change that touches a lot of rows", () => {
    useAgentStore.setState({ approval: { ...write, rowsAffected: 4_200_000 } });
    render(<ApprovalDialog />);
    // Grouped, because 4200000 and 42000000 look the same at a glance.
    expect(screen.getByText(/4,200,000 rows/)).toBeTruthy();
  });

  it("says plainly when a change affects nothing", () => {
    // Worth approving anyway — a WHERE that matched nothing is usually a bug
    // in the statement, and the user should see that rather than a blank.
    useAgentStore.setState({ approval: { ...write, rowsAffected: 0 } });
    render(<ApprovalDialog />);
    expect(screen.getByText("Updates no rows.")).toBeTruthy();
  });

  it("says a schema change is being approved before it runs", () => {
    // No row count, because there is no honest one — and the difference is
    // the difference between undoable and not.
    useAgentStore.setState({
      approval: {
        ...write,
        change: "schema",
        rowsAffected: undefined,
        sql: "ALTER TABLE orders ADD INDEX (customer_id)",
      },
    });
    render(<ApprovalDialog />);

    expect(screen.getByText(/wants to change the schema/)).toBeTruthy();
    expect(screen.getByText(/cannot be tried and undone/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Run it/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't run it" })).toBeTruthy();
  });
});
