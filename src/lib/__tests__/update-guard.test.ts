import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { describeUpdateBlockers, updateBlockers } from "../update-guard";

const tab = (id: string, isDirty: boolean) => ({
  id,
  title: id,
  content: "",
  type: "query" as const,
  isDirty,
});

describe("updateBlockers", () => {
  beforeEach(() => {
    useResultStore.setState({ isExecuting: false });
    useEditorStore.setState({ tabs: [tab("t1", false)], activeTabId: "t1" });
  });

  it("finds nothing to stop an update on an idle app", () => {
    expect(updateBlockers()).toEqual([]);
    expect(describeUpdateBlockers()).toBeNull();
  });

  it("stops an update while a query is running", () => {
    useResultStore.setState({ isExecuting: true });
    expect(describeUpdateBlockers()).toMatch(/query is still running/);
  });

  it("stops an update with unsaved work, and counts it", () => {
    useEditorStore.setState({
      tabs: [tab("t1", true), tab("t2", true), tab("t3", false)],
      activeTabId: "t1",
    });
    expect(describeUpdateBlockers()).toMatch(/2 editor tabs have unsaved changes/);
  });

  it("uses the singular for one tab", () => {
    useEditorStore.setState({ tabs: [tab("t1", true)], activeTabId: "t1" });
    expect(describeUpdateBlockers()).toMatch(/1 editor tab has unsaved changes/);
  });

  it("names both reasons when both apply", () => {
    // Reporting only the first would send the user to fix one thing and
    // meet the same refusal again.
    useResultStore.setState({ isExecuting: true });
    useEditorStore.setState({ tabs: [tab("t1", true)], activeTabId: "t1" });

    const message = describeUpdateBlockers();
    expect(message).toMatch(/query is still running/);
    expect(message).toMatch(/unsaved changes/);
  });
});
