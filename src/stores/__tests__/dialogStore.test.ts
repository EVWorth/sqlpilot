import { beforeEach, describe, expect, it } from "vitest";
import { useDialogStore } from "../dialogStore";

describe("dialogStore (#450)", () => {
  beforeEach(() => {
    useDialogStore.setState({ open: null, target: {}, helpTab: "shortcuts" });
  });

  it("starts with nothing open", () => {
    expect(useDialogStore.getState().open).toBeNull();
  });

  it("opens a dialog", () => {
    useDialogStore.getState().openDialog("import");
    expect(useDialogStore.getState().open).toBe("import");
  });

  it("carries a target from a context menu", () => {
    useDialogStore.getState().openDialog("backup", { connectionId: "c1", database: "app" });

    expect(useDialogStore.getState().target).toEqual({ connectionId: "c1", database: "app" });
  });

  it("replaces the target rather than merging it", () => {
    // A dialog opened from the menu must not inherit the connection a previous
    // context-menu open selected — that is how you back up the wrong database.
    useDialogStore.getState().openDialog("backup", { connectionId: "c1", database: "app" });
    useDialogStore.getState().openDialog("backup");

    expect(useDialogStore.getState().target).toEqual({});
  });

  it("only holds one dialog at a time", () => {
    useDialogStore.getState().openDialog("backup");
    useDialogStore.getState().openDialog("restore");

    expect(useDialogStore.getState().open).toBe("restore");
  });

  it("opens help on the tab asked for", () => {
    useDialogStore.getState().openHelp("about");

    expect(useDialogStore.getState().open).toBe("help");
    expect(useDialogStore.getState().helpTab).toBe("about");
  });

  it("clears a stale target when opening help", () => {
    useDialogStore.getState().openDialog("backup", { connectionId: "c1" });
    useDialogStore.getState().openHelp("shortcuts");

    expect(useDialogStore.getState().target).toEqual({});
  });

  it("closes and forgets the target", () => {
    useDialogStore.getState().openDialog("restore", { connectionId: "c1" });

    useDialogStore.getState().closeDialog();

    expect(useDialogStore.getState().open).toBeNull();
    expect(useDialogStore.getState().target).toEqual({});
  });

  it("remembers the help tab across a close", () => {
    // Reopening help from the toolbar should land where the user left it
    // rather than snapping back to shortcuts.
    useDialogStore.getState().openHelp("about");
    useDialogStore.getState().closeDialog();

    expect(useDialogStore.getState().helpTab).toBe("about");
  });
});
