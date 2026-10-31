import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../stores/editorStore";
import { useSqliteStore } from "../../../stores/sqliteStore";
import { useTransactionStore } from "../../../stores/transactionStore";
import type { EditorTab } from "../../../types";
import { RollbackSwitchDialog } from "../RollbackSwitchDialog";

const tab = (id: string, title: string, connectionId?: string) =>
  ({ id, title, connectionId, content: "", type: "query", isDirty: false }) as EditorTab;

describe("RollbackSwitchDialog (#843)", () => {
  beforeEach(() => useEditorStore.setState({ pendingSwitch: null }));

  it("shows nothing while no switch is waiting", () => {
    render(<RollbackSwitchDialog />);
    expect(screen.queryByText("Roll back and switch")).toBeNull();
  });

  it("names the tab, says what is lost, and switches only on confirm", () => {
    const proceed = vi.fn();
    useEditorStore.setState({ pendingSwitch: { inTransaction: [tab("t1", "Orders fix")], proceed } });
    render(<RollbackSwitchDialog />);

    expect(screen.getByText("Switch a tab with an open transaction?")).toBeInTheDocument();
    expect(screen.getByText(/"Orders fix" has a transaction open/)).toBeInTheDocument();
    expect(screen.getByText(/rolls back everything not committed/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Roll back and switch"));
    expect(proceed).toHaveBeenCalledOnce();
    expect(useEditorStore.getState().pendingSwitch).toBeNull();
  });

  // #935: on a SQLite file the transaction is the file's connection's, and
  // only moving the last tab off the file ends it.
  it("says the transaction is on the file's connection for the last tab on a SQLite file", () => {
    useSqliteStore.setState({ sessions: [{ id: "lite-1", path: "/data/app.db", name: "app.db", openedAt: "" }] });
    useTransactionStore.setState({ open: {}, openConnections: { "lite-1": true } });
    useEditorStore.setState({ pendingSwitch: { inTransaction: [tab("t1", "Notes", "lite-1")], proceed: vi.fn() } });
    render(<RollbackSwitchDialog />);

    expect(screen.getByText(/"Notes" is the last tab on app\.db, and a transaction is open on the file's connection/))
      .toBeInTheDocument();
    expect(screen.queryByText(/ends the session/)).toBeNull();
    useTransactionStore.setState({ openConnections: {} });
    useSqliteStore.setState({ sessions: [] });
  });

  it("keeps everything as it was on Cancel", () => {
    const proceed = vi.fn();
    useEditorStore.setState({
      pendingSwitch: { inTransaction: [tab("t1", "A"), tab("t2", "B")], proceed },
    });
    render(<RollbackSwitchDialog />);

    expect(screen.getByText("Switch tabs with open transactions?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));

    expect(proceed).not.toHaveBeenCalled();
    expect(useEditorStore.getState().pendingSwitch).toBeNull();
  });
});
