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
  useAgentStore.setState({ approval: null });
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
    expect(screen.getByText(/This changes 4 rows/)).toBeTruthy();
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

    fireEvent.keyDown(window, { key: "Escape" });

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
    expect(screen.getByText(/changes no rows/)).toBeTruthy();
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
