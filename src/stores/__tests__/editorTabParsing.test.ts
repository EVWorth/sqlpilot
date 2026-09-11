import { describe, expect, it } from "vitest";
import { parsePersistedTab } from "../../lib/editor-session";

const base = { id: "t1", title: "Query", content: "SELECT 1", isDirty: true };

describe("parsePersistedTab (#449)", () => {
  it("treats a tab with no type as a query tab", () => {
    // `type` used to be optional and absent meant query. Sessions written by
    // an older build still look like that.
    expect(parsePersistedTab(base)).toMatchObject({ type: "query", id: "t1" });
  });

  it("clears isDirty — the persisted content is the new baseline", () => {
    expect(parsePersistedTab(base)?.isDirty).toBe(false);
  });

  it("keeps a complete routine tab", () => {
    const tab = parsePersistedTab({
      ...base,
      type: "routine",
      connectionId: "c",
      database: "d",
      routineName: "r",
      routineType: "FUNCTION",
    });

    expect(tab).toMatchObject({ type: "routine", routineType: "FUNCTION", routineName: "r" });
  });

  it("drops a routine tab with no routine name", () => {
    // Rendering it would hand RoutineViewer undefined props.
    expect(
      parsePersistedTab({ ...base, type: "routine", connectionId: "c", database: "d" }),
    ).toBeNull();
  });

  it("drops a routine tab whose type is not one the server has", () => {
    expect(
      parsePersistedTab({
        ...base,
        type: "routine",
        connectionId: "c",
        database: "d",
        routineName: "r",
        routineType: "TRIGGER",
      }),
    ).toBeNull();
  });

  it("drops a structure tab with no database", () => {
    expect(
      parsePersistedTab({ ...base, type: "structure", connectionId: "c", tableName: "t" }),
    ).toBeNull();
  });

  it("keeps a designer tab with no table — that is a new table", () => {
    expect(
      parsePersistedTab({ ...base, type: "designer", connectionId: "c", database: "d" }),
    ).toMatchObject({ type: "designer", tableName: undefined });
  });

  it("drops an admin tab with no connection", () => {
    expect(parsePersistedTab({ ...base, type: "admin" })).toBeNull();
  });

  it("drops a kind this build does not know", () => {
    // `compare` was one of these before it was cut.
    expect(parsePersistedTab({ ...base, type: "compare" })).toBeNull();
  });

  it("drops anything that is not a tab at all", () => {
    for (const junk of [null, undefined, 42, "tab", [], {}]) {
      expect(parsePersistedTab(junk)).toBeNull();
    }
  });

  it("drops a tab with no id or title", () => {
    expect(parsePersistedTab({ title: "x" })).toBeNull();
    expect(parsePersistedTab({ id: "x" })).toBeNull();
  });

  it("ignores fields of the wrong type rather than trusting them", () => {
    const tab = parsePersistedTab({ ...base, content: 42, connectionId: { nope: true } });
    expect(tab).toMatchObject({ content: "", connectionId: undefined });
  });
});
