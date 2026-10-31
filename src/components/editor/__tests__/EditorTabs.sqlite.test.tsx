import { fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sqliteExecute, sqliteClose, sqliteOpen } = vi.hoisted(() => ({
  sqliteExecute: vi.fn(),
  sqliteClose: vi.fn(),
  sqliteOpen: vi.fn(),
}));
vi.mock("../../../lib/tauri-api", () => ({
  api: { sqliteExecute, sqliteClose, sqliteOpen },
  CommandError: class CommandError extends Error {
    transaction?: string;
  },
}));
vi.mock("../../../stores/historyStore", () => ({
  useHistoryStore: { getState: () => ({ addEntry: vi.fn() }) },
}));

import { forgetConnectionKind } from "../../../lib/datasource";
import { useEditorStore } from "../../../stores/editorStore";
import { useResultStore } from "../../../stores/resultStore";
import { useSqliteStore } from "../../../stores/sqliteStore";
import { useTransactionStore } from "../../../stores/transactionStore";
import type { EditorTab } from "../../../types";
import { EditorTabs } from "../EditorTabs";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = vi.fn();

const tab = (id: string, title: string, connectionId: string): EditorTab => ({
  id,
  title,
  content: "",
  type: "query",
  isDirty: false,
  connectionId,
});

/** What `sqlite_execute` returns for one statement. */
const ran = (sql: string, inTransaction: boolean) => [{
  query_id: "q",
  statement_index: 0,
  sql,
  columns: [],
  rows: [],
  rows_affected: 0,
  execution_time_ms: 1,
  warnings: [],
  rows_truncated: false,
  truncation_reason: null,
  in_transaction: inTransaction,
}];

const badges = () => screen.queryAllByText(", transaction open").length;
const badgeOn = (title: string) => {
  const el = screen.getByText(title).closest("[role=tab]");
  if (!(el instanceof HTMLElement)) throw new Error(`no tab ${title}`);
  return within(el).queryByText(", transaction open");
};

/**
 * The TX badge and the close prompt for a SQLite file, against the real
 * stores (#935). A file has one connection, shared by every tab on it, so a
 * BEGIN in one tab is open in all of them.
 */
describe("a SQLite file's shared transaction in the tab strip (#935)", () => {
  beforeEach(async () => {
    sqliteExecute.mockReset();
    sqliteClose.mockReset().mockResolvedValue(undefined);
    sqliteOpen.mockReset().mockResolvedValue("lite-1");
    useSqliteStore.setState({ sessions: [], opening: false, error: null });
    await useSqliteStore.getState().openPath("/data/app.db");
    useTransactionStore.setState({ open: {}, openConnections: {} });
    useEditorStore.setState({
      tabs: [tab("tab-a", "Notes A", "lite-1"), tab("tab-b", "Notes B", "lite-1"), tab("tab-c", "Other", "conn-x")],
      activeTabId: "tab-a",
      pendingClose: null,
      pendingSwitch: null,
    });
  });
  afterEach(() => forgetConnectionKind("lite-1"));

  async function run(sql: string, tabId: string, inTransaction: boolean) {
    sqliteExecute.mockResolvedValueOnce(ran(sql, inTransaction));
    await act(() => useResultStore.getState().executeQuery("lite-1", sql, undefined, tabId));
  }

  it("marks every tab on the file after BEGIN in one, and clears them all on COMMIT", async () => {
    render(<EditorTabs />);
    expect(badges()).toBe(0);

    await run("BEGIN", "tab-a", true);
    expect(badgeOn("Notes A")).toBeInTheDocument();
    expect(badgeOn("Notes B")).toBeInTheDocument();
    expect(badgeOn("Other")).toBeNull();
    expect(screen.getAllByTitle(/on this file's connection/)).toHaveLength(2);

    // From the other tab: the connection is the same.
    await run("COMMIT", "tab-b", false);
    expect(badges()).toBe(0);
  });

  it("closes one of two tabs on the file without asking, and asks for the last", async () => {
    render(<EditorTabs />);
    await run("BEGIN", "tab-a", true);

    act(() => useEditorStore.getState().requestClose("close", "tab-a"));
    expect(screen.queryByText("Roll back and close")).toBeNull();
    expect(screen.queryByText("Notes A")).toBeNull();
    // The transaction is still open, on the tab left on the file.
    expect(badgeOn("Notes B")).toBeInTheDocument();
    expect(sqliteExecute).toHaveBeenCalledTimes(1);

    act(() => useEditorStore.getState().requestClose("close", "tab-b"));
    expect(screen.getByText("Close tab with an open transaction?")).toBeInTheDocument();
    expect(screen.getByText(/"Notes B" is the last tab on app\.db/)).toBeInTheDocument();

    // Confirming rolls the file's transaction back, as the button says.
    sqliteExecute.mockResolvedValueOnce(ran("ROLLBACK", false));
    fireEvent.click(screen.getByText("Roll back and close"));
    expect(screen.queryByText("Notes B")).toBeNull();
    expect(sqliteExecute).toHaveBeenLastCalledWith("lite-1", "ROLLBACK");
    await vi.waitFor(() => expect(useTransactionStore.getState().openConnections).toEqual({}));
  });

  it("drops the badges when the file is closed", async () => {
    render(<EditorTabs />);
    await run("BEGIN", "tab-a", true);
    expect(badges()).toBe(2);

    await act(() => useSqliteStore.getState().close("lite-1"));

    expect(sqliteClose).toHaveBeenCalledWith("lite-1");
    expect(badges()).toBe(0);
  });
});
