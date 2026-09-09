import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const historyList = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/tauri-api", () => ({ api: { historyList } }));

import { HistoryQuickOpen } from "../HistoryQuickOpen";

function entry(id: string, sql: string, overrides = {}) {
  return {
    id,
    sql,
    connectionName: "prod",
    database: "app",
    executedAt: "2026-01-01T00:00:00Z",
    executionTimeMs: 12,
    rowCount: 1,
    status: "success" as const,
    error: null,
    errorCode: null,
    errorSqlState: null,
    redacted: false,
    truncated: false,
    ...overrides,
  };
}

function open(props: Partial<React.ComponentProps<typeof HistoryQuickOpen>> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(<HistoryQuickOpen isOpen onClose={onClose} onPick={onPick} {...props} />);
  return { onPick, onClose };
}

describe("HistoryQuickOpen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyList.mockResolvedValue([
      entry("a", "SELECT * FROM users"),
      entry("b", "SELECT * FROM orders"),
    ]);
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <HistoryQuickOpen isOpen={false} onClose={vi.fn()} onPick={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists the most recent statements on open", async () => {
    open();
    expect(await screen.findByText("SELECT * FROM users")).toBeInTheDocument();
  });

  it("ignores the panel's filters and asks for the whole history", async () => {
    // Someone reaching for a statement mid-thought wants all of it, not
    // whatever slice the sidebar happens to be showing.
    open();
    await waitFor(() => expect(historyList).toHaveBeenCalled());

    expect(historyList).toHaveBeenCalledWith(
      expect.objectContaining({ search: null, status: null, connectionNames: null, sort: "recent" }),
    );
  });

  it("searches as the user types", async () => {
    open();
    await waitFor(() => expect(historyList).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Search query history"), {
      target: { value: "orders" },
    });

    await waitFor(() => expect(historyList).toHaveBeenLastCalledWith(expect.objectContaining({ search: "orders" })));
  });

  it("inserts the highlighted statement on Enter and closes", async () => {
    const { onPick, onClose } = open();
    await screen.findByText("SELECT * FROM users");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(onPick).toHaveBeenCalledWith("SELECT * FROM users");
    expect(onClose).toHaveBeenCalled();
  });

  it("moves the highlight with the arrow keys", async () => {
    const { onPick } = open();
    await screen.findByText("SELECT * FROM users");
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(onPick).toHaveBeenCalledWith("SELECT * FROM orders");
  });

  it("does not move past the last entry", async () => {
    const { onPick } = open();
    await screen.findByText("SELECT * FROM users");
    const dialog = screen.getByRole("dialog");

    for (let i = 0; i < 10; i++) fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(onPick).toHaveBeenCalledWith("SELECT * FROM orders");
  });

  it("does not move above the first entry", async () => {
    const { onPick } = open();
    await screen.findByText("SELECT * FROM users");
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(onPick).toHaveBeenCalledWith("SELECT * FROM users");
  });

  it("closes on Escape without inserting", async () => {
    const { onPick, onClose } = open();
    await screen.findByText("SELECT * FROM users");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("inserts nothing when nothing matched", async () => {
    // Enter on an empty list must not insert the search text.
    historyList.mockResolvedValue([]);
    const { onPick, onClose } = open();
    await screen.findByText("No history yet");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("inserts on click", async () => {
    const { onPick } = open();
    fireEvent.click(await screen.findByText("SELECT * FROM orders"));
    expect(onPick).toHaveBeenCalledWith("SELECT * FROM orders");
  });

  it("closes when the backdrop is clicked", async () => {
    const { onClose } = open();
    await screen.findByText("SELECT * FROM users");

    fireEvent.click(document.querySelector(".fixed.inset-0") as HTMLElement);

    expect(onClose).toHaveBeenCalled();
  });

  it("says so when the history cannot be read", async () => {
    historyList.mockRejectedValue(new Error("database is locked"));
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
  });
});
