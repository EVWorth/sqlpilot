import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../stores/editorStore";
import type { EditorTab } from "../../../types";
import { RollbackSwitchDialog } from "../RollbackSwitchDialog";

const tab = (id: string, title: string) => ({ id, title, content: "", type: "query", isDirty: false }) as EditorTab;

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
