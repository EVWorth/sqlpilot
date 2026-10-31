import { beforeEach, describe, expect, it, vi } from "vitest";

const sqliteExecuteMock = vi.hoisted(() => vi.fn());
vi.mock("../tauri-api", () => ({
  api: { sqliteExecute: (...args: unknown[]) => sqliteExecuteMock(...args) },
  CommandError: class CommandError extends Error {
    transaction?: string;
  },
}));

import { useEditorStore } from "../../stores/editorStore";
import { useTransactionStore } from "../../stores/transactionStore";
import type { EditorTab } from "../../types";
import { connectionsLeft, noteSqliteTransaction } from "../sqlite-transactions";

const tab = (id: string, connectionId?: string) =>
  ({ id, title: id, connectionId, content: "", type: "query", isDirty: false }) as EditorTab;

describe("connectionsLeft (#935)", () => {
  it("names an open connection the tabs have just let go of", () => {
    expect(connectionsLeft({ "lite-1": true }, [tab("a", "lite-1")], [tab("a", "conn-b")])).toEqual(["lite-1"]);
  });

  it("keeps one another tab is still on", () => {
    expect(connectionsLeft({ "lite-1": true }, [tab("a", "lite-1"), tab("b", "lite-1")], [tab("b", "lite-1")]))
      .toEqual([]);
  });

  it("skips one no tab was on, so a run from no tab is not rolled back", () => {
    expect(connectionsLeft({ "lite-1": true }, [tab("a")], [])).toEqual([]);
  });
});

describe("noteSqliteTransaction (#935)", () => {
  beforeEach(() => {
    sqliteExecuteMock.mockReset().mockResolvedValue([{ in_transaction: false }]);
    useTransactionStore.setState({ open: {}, openConnections: {} });
    useEditorStore.setState({ tabs: [tab("a", "lite-1"), tab("b", "lite-1")], activeTabId: "a" });
  });

  it("records what the connection reported, and nothing when it did not say", () => {
    noteSqliteTransaction("lite-1", "open");
    expect(useTransactionStore.getState().openConnections).toEqual({ "lite-1": true });
    noteSqliteTransaction("lite-1", undefined);
    expect(useTransactionStore.getState().openConnections).toEqual({ "lite-1": true });
    noteSqliteTransaction("lite-1", "none");
    expect(useTransactionStore.getState().openConnections).toEqual({});
  });

  it("rolls back once the last tab on the file has gone, not before", async () => {
    noteSqliteTransaction("lite-1", "open");

    useEditorStore.setState({ tabs: [tab("b", "lite-1")] });
    expect(sqliteExecuteMock).not.toHaveBeenCalled();

    useEditorStore.setState({ tabs: [tab("b", "conn-other")] });
    expect(sqliteExecuteMock).toHaveBeenCalledWith("lite-1", "ROLLBACK");
    await vi.waitFor(() => expect(useTransactionStore.getState().openConnections).toEqual({}));
  });

  it("keeps the flag when the rollback fails without saying", async () => {
    sqliteExecuteMock.mockRejectedValue(new Error("gone"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    noteSqliteTransaction("lite-1", "open");

    useEditorStore.setState({ tabs: [] });

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(useTransactionStore.getState().openConnections).toEqual({ "lite-1": true });
  });
});
