import { describe, expect, it } from "vitest";
import type { EditorTab } from "../../types";
import { buildTab, findOpenTab, TAB_KINDS, type TabParams } from "../tab-kinds";

/** Params that satisfy every kind, for the sweeps below. */
const PARAMS: { [K in keyof TabParams]: TabParams[K] } = {
  query: { connectionId: "c1", database: "shop" },
  structure: { connectionId: "c1", database: "shop", tableName: "orders" },
  admin: { connectionId: "c1" },
  routine: {
    connectionId: "c1",
    database: "shop",
    routineName: "recalc",
    routineType: "PROCEDURE",
  },
  designer: { connectionId: "c1", database: "shop", tableName: "orders" },
};

describe("tab-kinds (#286)", () => {
  describe("every kind", () => {
    it.each(TAB_KINDS)("%s builds a tab that is not dirty and has an id", (kind) => {
      const tab = buildTab("tab-1", kind, PARAMS[kind] as never);
      expect(tab.id).toBe("tab-1");
      expect(tab.type).toBe(kind);
      expect(tab.isDirty).toBe(false);
      expect(tab.content).toBe("");
    });

    it.each(TAB_KINDS)("%s has a title", (kind) => {
      // A tab with no title is a tab you cannot find again.
      expect(buildTab("tab-1", kind, PARAMS[kind] as never).title.trim()).not.toBe("");
    });

    it.each(TAB_KINDS)("%s carries the connection it was opened for", (kind) => {
      expect(buildTab("tab-1", kind, PARAMS[kind] as never).connectionId).toBe("c1");
    });
  });

  describe("finding an open tab", () => {
    const open = (kind: keyof TabParams) => buildTab("existing", kind, PARAMS[kind] as never);

    it.each(["structure", "admin", "routine", "designer"] as const)(
      "%s reopens the tab already showing it",
      (kind) => {
        const tabs = [open(kind)];
        expect(findOpenTab(tabs, kind, PARAMS[kind] as never)?.id).toBe("existing");
      },
    );

    it("never reuses a query tab", () => {
      // A second query tab is a second query tab, which is the point of tabs.
      const tabs = [open("query")];
      expect(findOpenTab(tabs, "query", PARAMS.query)).toBeUndefined();
    });

    it("tells two tables apart", () => {
      const tabs = [open("structure")];
      expect(findOpenTab(tabs, "structure", { ...PARAMS.structure, tableName: "users" }))
        .toBeUndefined();
    });

    it("tells two databases apart", () => {
      const tabs = [open("structure")];
      expect(findOpenTab(tabs, "structure", { ...PARAMS.structure, database: "other" }))
        .toBeUndefined();
    });

    it("tells two connections apart", () => {
      // Two servers with a database of the same name is the ordinary case.
      const tabs = [open("structure")];
      expect(findOpenTab(tabs, "structure", { ...PARAMS.structure, connectionId: "c2" }))
        .toBeUndefined();
    });

    it("tells a procedure from a function of the same name", () => {
      const tabs = [open("routine")];
      expect(findOpenTab(tabs, "routine", { ...PARAMS.routine, routineType: "FUNCTION" }))
        .toBeUndefined();
    });

    it("keeps one admin tab per connection, whatever else is open", () => {
      const tabs = [open("query"), open("admin"), open("structure")];
      expect(findOpenTab(tabs, "admin", PARAMS.admin)?.type).toBe("admin");
    });

    it("does not mistake a designer tab for a structure tab", () => {
      // Both carry a connection, a database and a table name.
      const tabs = [open("designer")];
      expect(findOpenTab(tabs, "structure", PARAMS.structure)).toBeUndefined();
    });

    it("treats an empty table name and none as the same new table", () => {
      // Otherwise a second designer opens for the same thing.
      const tabs: EditorTab[] = [
        buildTab("existing", "designer", { connectionId: "c1", database: "shop" }),
      ];
      expect(
        findOpenTab(tabs, "designer", {
          connectionId: "c1",
          database: "shop",
          tableName: "",
        })?.id,
      ).toBe("existing");
    });
  });

  describe("titles", () => {
    it("names a structure tab after its table", () => {
      expect(buildTab("t", "structure", PARAMS.structure).title).toContain("orders");
    });

    it("marks a procedure and a function differently", () => {
      const procedure = buildTab("t", "routine", PARAMS.routine).title;
      const fn = buildTab("t", "routine", { ...PARAMS.routine, routineType: "FUNCTION" }).title;
      expect(procedure).not.toBe(fn);
      expect(procedure).toContain("recalc");
      expect(fn).toContain("recalc");
    });

    it("says a designer tab with no table is a new one", () => {
      expect(buildTab("t", "designer", { connectionId: "c1", database: "shop" }).title)
        .toContain("New Table");
    });
  });

  it("lists every kind, so adding one without a spec fails here", () => {
    expect(TAB_KINDS.sort()).toEqual(
      ["admin", "designer", "query", "routine", "structure"],
    );
  });
});
