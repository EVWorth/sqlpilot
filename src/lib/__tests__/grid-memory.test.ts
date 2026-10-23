import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "../../stores/editorStore";
import { forgetGridMemory, keepGrid, keptGridTabs, recallGrid } from "../grid-memory";

describe("grid memory", () => {
  const rows = [[1, "ada"]];

  beforeEach(() => {
    forgetGridMemory([]);
    useEditorStore.setState({
      tabs: [{ id: "tab-1", title: "tab-1", content: "", type: "query", isDirty: false }],
      activeTabId: "tab-1",
    });
  });

  it("keeps no entry for a tab with nothing to keep", () => {
    // An empty entry handed back nothing and only held the results alive.
    keepGrid({ tab: "tab-1", owner: rows }, "sorting", undefined);

    expect(keptGridTabs()).toEqual([]);
  });

  it("drops the entry once its last slot is forgotten", () => {
    const scope = { tab: "tab-1", owner: rows };
    keepGrid(scope, "sorting", [{ id: "name", desc: false }]);
    keepGrid(scope, "sorting", undefined);

    expect(keptGridTabs()).toEqual([]);
  });

  it("drops what was kept on other results when the tab asks for it", () => {
    keepGrid({ tab: "tab-1", owner: rows }, "sorting", [{ id: "name", desc: false }]);

    expect(recallGrid({ tab: "tab-1", owner: [[2, "bob"]] }, "sorting")).toBeUndefined();
    expect(keptGridTabs()).toEqual([]);
  });

  it("hands back what was kept on the same results", () => {
    const scope = { tab: "tab-1", owner: rows };
    keepGrid(scope, "columnSizing", { name: 120 });

    expect(recallGrid(scope, "columnSizing")).toEqual({ name: 120 });
    expect(keptGridTabs()).toEqual(["tab-1"]);
  });
});
