import { describe, expect, it } from "vitest";
import {
  buildCategoryTree,
  categoryLeafName,
  isUnderCategory,
  normaliseCategoryPath,
  reparentCategory,
  splitCategoryPath,
  visibleCategoryRows,
} from "../category-tree";

/** Every row's path, in render order. */
const paths = (nodes: { path: string }[]) => nodes.map((n) => n.path);

describe("splitCategoryPath", () => {
  it("splits on the separator", () => {
    expect(splitCategoryPath("Reports/Daily")).toEqual(["Reports", "Daily"]);
  });

  it("drops empty segments — a stray separator is a typo, not a folder", () => {
    expect(splitCategoryPath("Reports//Daily/")).toEqual(["Reports", "Daily"]);
  });

  it("trims each segment", () => {
    expect(splitCategoryPath(" Reports / Daily ")).toEqual(["Reports", "Daily"]);
  });

  it("handles a flat name", () => {
    expect(splitCategoryPath("Uncategorized")).toEqual(["Uncategorized"]);
  });

  it("handles an empty string", () => {
    expect(splitCategoryPath("")).toEqual([]);
  });
});

describe("normaliseCategoryPath", () => {
  it("puts a messy path back together", () => {
    expect(normaliseCategoryPath("/Reports//Daily/ ")).toBe("Reports/Daily");
  });
});

describe("categoryLeafName", () => {
  it("is the last segment", () => {
    expect(categoryLeafName("Reports/Daily/Revenue")).toBe("Revenue");
  });

  it("is the whole name when flat", () => {
    expect(categoryLeafName("Reports")).toBe("Reports");
  });
});

describe("isUnderCategory", () => {
  it("a path is under itself", () => {
    expect(isUnderCategory("Reports", "Reports")).toBe(true);
  });

  it("a child is under its parent", () => {
    expect(isUnderCategory("Reports/Daily", "Reports")).toBe(true);
  });

  it("a sibling is not", () => {
    expect(isUnderCategory("Reporting", "Reports")).toBe(false);
  });

  it("a prefix that is not a path boundary is not", () => {
    // "Reports Archive" starts with "Reports" but is a different folder.
    expect(isUnderCategory("Reports Archive", "Reports")).toBe(false);
  });
});

describe("buildCategoryTree", () => {
  it("nests a path under its parent", () => {
    const [reports] = buildCategoryTree(["Reports", "Reports/Daily"]);

    expect(reports.path).toBe("Reports");
    expect(paths(reports.children)).toEqual(["Reports/Daily"]);
  });

  it("creates a parent nothing declared", () => {
    // A category called "Reports/Daily" with no "Reports" beside it still has
    // to appear under a Reports folder, or the nesting is invisible.
    const tree = buildCategoryTree(["Reports/Daily"]);

    expect(paths(tree)).toEqual(["Reports"]);
    expect(paths(tree[0].children)).toEqual(["Reports/Daily"]);
  });

  it("records depth for indentation", () => {
    const tree = buildCategoryTree(["A/B/C"]);
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it("sorts siblings alphabetically", () => {
    expect(paths(buildCategoryTree(["Zed", "Alpha", "Mid"]))).toEqual(["Alpha", "Mid", "Zed"]);
  });

  it("does not duplicate a parent declared twice", () => {
    const tree = buildCategoryTree(["Reports", "Reports/Daily", "Reports/Weekly"]);

    expect(tree).toHaveLength(1);
    expect(paths(tree[0].children)).toEqual(["Reports/Daily", "Reports/Weekly"]);
  });

  it("ignores an empty category name", () => {
    expect(buildCategoryTree(["", "  ", "Real"])).toHaveLength(1);
  });

  it("keeps a flat list flat", () => {
    expect(paths(buildCategoryTree(["Uncategorized", "Reports"]))).toEqual([
      "Reports",
      "Uncategorized",
    ]);
  });
});

describe("visibleCategoryRows", () => {
  const tree = buildCategoryTree(["Reports/Daily/Revenue", "Ops"]);

  it("shows only the top level when nothing is expanded", () => {
    expect(paths(visibleCategoryRows(tree, () => false))).toEqual(["Ops", "Reports"]);
  });

  it("shows a folder's children when it is expanded", () => {
    const rows = visibleCategoryRows(tree, (p) => p === "Reports");
    expect(paths(rows)).toEqual(["Ops", "Reports", "Reports/Daily"]);
  });

  it("hides descendants of a collapsed folder but keeps the folder", () => {
    // Otherwise there is nothing left to click to open it again.
    const rows = visibleCategoryRows(tree, (p) => p === "Reports" || p === "Reports/Daily");
    expect(paths(rows)).toContain("Reports/Daily/Revenue");

    const collapsed = visibleCategoryRows(tree, (p) => p === "Reports");
    expect(paths(collapsed)).toContain("Reports/Daily");
    expect(paths(collapsed)).not.toContain("Reports/Daily/Revenue");
  });
});

describe("reparentCategory", () => {
  it("moves a folder under a new parent", () => {
    expect(reparentCategory("Daily", "Reports")).toBe("Reports/Daily");
  });

  it("keeps only the leaf name when moving", () => {
    expect(reparentCategory("Ops/Daily", "Reports")).toBe("Reports/Daily");
  });

  it("moves a folder to the top level", () => {
    expect(reparentCategory("Reports/Daily", null)).toBe("Daily");
  });

  it("refuses to move a folder inside itself", () => {
    // The subtree would detach from the tree and be lost.
    expect(reparentCategory("Reports", "Reports")).toBeNull();
  });

  it("refuses to move a folder inside its own descendant", () => {
    expect(reparentCategory("Reports", "Reports/Daily")).toBeNull();
  });

  it("allows a move into a folder that merely shares a prefix", () => {
    expect(reparentCategory("Reports", "Reports Archive")).toBe("Reports Archive/Reports");
  });
});
