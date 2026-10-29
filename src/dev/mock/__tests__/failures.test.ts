import { afterEach, describe, expect, it, vi } from "vitest";
import bindingsSource from "../../../lib/bindings.ts?raw";
import { QUERY_ERROR_COMMANDS } from "../failures";
import { optionsFromUrl } from "../state";
import { call, install, rejection } from "./helpers";

async function connected(search: string): Promise<string> {
  install(search);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const conn = await call<{ id: string }>("connect", { profileId: "profile-local" });
  return conn.id;
}

const tableArgs = (connectionId: string) => ({ connectionId, database: "shop", table: "orders" });

describe("?fail= error injection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the list from the URL", () => {
    expect(optionsFromUrl("?mock=connected&fail=get_foreign_keys,%20save_connection_profile").fail).toEqual([
      "get_foreign_keys",
      "save_connection_profile",
    ]);
    expect(optionsFromUrl("?mock").fail).toEqual([]);
  });

  it("knows which commands reject with a QueryError", () => {
    // From the generated bindings, so a new QueryError command is noticed.
    const typed = [...bindingsSource.matchAll(/QueryError>\(__TAURI_INVOKE\("([a-z_]+)"/g)].map((m) => m[1]);
    expect(typed.length).toBeGreaterThan(0);
    expect(new Set(typed)).toEqual(QUERY_ERROR_COMMANDS);
  });

  it("fails the named commands with the string a CoreError renders as", async () => {
    const id = await connected("?mock=connected&fail=get_foreign_keys,save_connection_profile");

    expect(await rejection("get_foreign_keys", tableArgs(id))).toMatch(/^Schema error: .*2013 \(HY000\)/);
    expect(await rejection("save_connection_profile", { profile: {} })).toMatch(/^Storage error: /);
    // Everything else still answers.
    expect(await call("get_indexes", tableArgs(id))).not.toEqual([]);
  });

  it("fails a QueryError command with the structured error", async () => {
    const id = await connected("?mock=connected&fail=execute_query");
    expect(await rejection("execute_query", { connectionId: id, sql: "SELECT 1" })).toEqual({
      message: "Lost connection to MySQL server during query",
      code: 2013,
      sqlState: "HY000",
      statementIndex: 0,
    });
  });

  it("matches by prefix with a trailing *", async () => {
    const id = await connected("?mock=connected&fail=get_*");
    expect(await rejection("get_columns", tableArgs(id))).toMatch(/^Schema error: /);
    expect(await rejection("get_databases", { connectionId: id })).toMatch(/^Schema error: /);
    expect(await call("list_connections")).toHaveLength(1);
  });

  it("fails a plugin command with a plain string", async () => {
    install("?mock&fail=plugin:updater|check");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await rejection("plugin:updater|check")).toBe("updater.check failed: network error");
  });

  it("fails nothing without the switch", async () => {
    const id = await connected("?mock=connected");
    expect(await call("get_foreign_keys", tableArgs(id))).toHaveLength(1);
  });
});
