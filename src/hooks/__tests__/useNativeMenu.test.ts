import { act, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS, MENUS } from "../../lib/actions";
import type { NativeMenu, NativeMenuEntry } from "../../lib/bindings";
import { useConnectionStore } from "../../stores/connectionStore";
import { buildNativeMenu, toAccelerator, useNativeMenu } from "../useNativeMenu";

const setNativeMenu = vi.fn<(menus: NativeMenu[]) => Promise<null>>(() => Promise.resolve(null));
vi.mock("../../lib/tauri-api", () => ({
  api: { setNativeMenu: (menus: NativeMenu[]) => setNativeMenu(menus) },
}));

type Item = Extract<NativeMenuEntry, { type: "item" }>;

/** Every item in a description, submenus included. */
function items(entries: NativeMenuEntry[]): Item[] {
  return entries.flatMap((entry) => {
    if (entry.type === "item") return [entry];
    if (entry.type === "submenu") return items(entry.entries);
    return [];
  });
}

const allItems = (menus: NativeMenu[]) => menus.flatMap((menu) => items(menu.entries));

function connectTo(menus: NativeMenu[]): Extract<NativeMenuEntry, { type: "submenu" }> {
  const connection = menus.find((menu) => menu.label === "Connection")!;
  const submenu = connection.entries.find((entry) => entry.type === "submenu");
  if (submenu?.type !== "submenu") throw new Error("no Connect to submenu");
  return submenu;
}

const PROFILES = [
  { id: "p1", name: "Local", host: "127.0.0.1" },
  { id: "p2", name: "", host: "db.example.test" },
  { id: "p3", name: "Staging", host: "staging.example.test" },
];

describe("buildNativeMenu", () => {
  it("has the in-app menu bar's menus and actions, in order (#892)", () => {
    const menus = buildNativeMenu({ connected: true }, [], new Set(), []);
    expect(menus.map((m) => m.label)).toEqual(MENUS.map((m) => m.label));
    const expected = MENUS.flatMap((menu) => menu.entries.flatMap((e) => (e.type === "item" ? [e.id] : [])));
    const actual = allItems(menus).map((i) => i.id).filter((id) => !id.startsWith("connect:"));
    expect(actual).toEqual(expected);
  });

  it("greys out what needs a connection while there is none (#821)", () => {
    const offline = allItems(buildNativeMenu({ connected: false }, [], new Set(), []));
    const disabled = offline.filter((i) => !i.enabled).map((i) => i.id);
    const needsConnection = ACTIONS.filter((a) => a.enabled && !a.enabled({ connected: false })).map((a) => a.id);
    expect(disabled.filter((id) => id !== "connect:none").sort()).toEqual(needsConnection.sort());

    const online = allItems(buildNativeMenu({ connected: true }, [], new Set(), []));
    expect(online.filter((i) => !i.enabled).map((i) => i.id)).toEqual(["connect:none"]);
  });

  it("lists saved profiles under Connection → Connect to (#863)", () => {
    const menus = buildNativeMenu({ connected: true }, PROFILES, new Set(["p1"]), ["p3"]);
    const submenu = connectTo(menus);
    expect(submenu.label).toBe("Connect to");
    expect(items(submenu.entries).map(({ id, label, enabled }) => ({ id, label, enabled }))).toEqual([
      // Open already: nothing to connect to.
      { id: "connect:p1", label: "Local", enabled: false },
      // No name: the host stands in, as in the in-app menu.
      { id: "connect:p2", label: "db.example.test", enabled: true },
      { id: "connect:p3", label: "Staging (connecting…)", enabled: false },
    ]);
    // Right after New Connection…, where the in-app menu has it.
    const connection = menus.find((m) => m.label === "Connection")!;
    expect(connection.entries[0]).toMatchObject({ type: "item", id: "new-connection" });
    expect(connection.entries[1]).toMatchObject({ type: "submenu" });
  });

  it("says so when there are no saved profiles", () => {
    const submenu = connectTo(buildNativeMenu({ connected: false }, [], new Set(), []));
    expect(submenu.entries).toEqual([
      { type: "item", id: "connect:none", label: "No saved connections", accelerator: null, enabled: false },
    ]);
  });

  it("gives shortcuts in Tauri's accelerator syntax", () => {
    expect(toAccelerator("Ctrl+Shift+F")).toBe("CmdOrCtrl+Shift+F");
    expect(toAccelerator("F1")).toBe("F1");
    expect(toAccelerator(undefined)).toBeNull();
    const formatSql = allItems(buildNativeMenu({ connected: true }, [], new Set(), [])).find((i) =>
      i.id === "format-sql"
    );
    expect(formatSql?.accelerator).toBe("CmdOrCtrl+Shift+F");
  });
});

describe("the default native menu in menu.rs", () => {
  // The menu macOS shows before the window loads is written out in Rust. An
  // id there with no handler would be a menu item that does nothing, which
  // is what Compare Schemas was (#892).
  const source = readFileSync("src-tauri/src/menu.rs", "utf8");
  const defaults = source.slice(source.indexOf("pub fn default_menus"), source.indexOf("pub fn build_menu"));
  const ids = [...defaults.matchAll(/\bitem\(\s*"([^"]+)"/g)].map((m) => m[1]);

  it("is found", () => {
    // A guard on the guard: a rewrite of menu.rs must not leave this checking nothing.
    expect(ids.length).toBeGreaterThan(20);
  });

  it("only uses ids AppLayout handles", () => {
    const handler = readFileSync("src/components/layout/AppLayout.tsx", "utf8");
    expect(ids.filter((id) => !handler.includes(`case "${id}":`))).toEqual([]);
  });

  it("has the same items as the in-app menu bar", () => {
    const inApp = MENUS.flatMap((menu) => menu.entries.flatMap((e) => (e.type === "item" ? [e.id] : [])));
    expect(ids).toEqual(inApp);
  });
});

describe("useNativeMenu", () => {
  beforeEach(() => {
    setNativeMenu.mockClear();
    useConnectionStore.setState({ profiles: [], activeConnections: [], connecting: [], selectedConnectionId: null });
  });
  afterEach(() => {
    useConnectionStore.setState({ profiles: [], activeConnections: [], connecting: [], selectedConnectionId: null });
  });

  it("does nothing where there is no native menu bar", () => {
    renderHook(() => useNativeMenu(false));
    expect(setNativeMenu).not.toHaveBeenCalled();
  });

  it("sends the menu, and again only when what it shows changes", () => {
    const { rerender } = renderHook(() => useNativeMenu(true));
    expect(setNativeMenu).toHaveBeenCalledTimes(1);
    expect(connectTo(setNativeMenu.mock.calls[0][0]).entries[0]).toMatchObject({ id: "connect:none" });

    rerender();
    // A new array with the same content is not a change.
    act(() => useConnectionStore.setState({ connecting: [] }));
    expect(setNativeMenu).toHaveBeenCalledTimes(1);

    act(() =>
      useConnectionStore.setState({
        profiles: [{ id: "p1", name: "Local", host: "127.0.0.1" }] as never,
      })
    );
    expect(setNativeMenu).toHaveBeenCalledTimes(2);
    expect(items(connectTo(setNativeMenu.mock.calls[1][0]).entries).map((i) => i.id)).toEqual(["connect:p1"]);
  });
});
