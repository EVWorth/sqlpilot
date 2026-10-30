import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionInfo } from "../../../lib/bindings";
import { useResultStore } from "../../../stores/resultStore";
import { call, install, settle } from "./helpers";

// #845 end to end in the browser preview: the mock backend's rejection goes
// through the real bindings, the API's CommandError and the result store,
// with nothing stubbed between them.
describe("a script whose second statement fails (?mock=connected)", () => {
  let conn: ConnectionInfo;

  beforeEach(async () => {
    install("?mock=connected");
    vi.useFakeTimers();
    conn = await call<ConnectionInfo>("connect", { profileId: "profile-local" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the first statement's rows and says which statement failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const script = "SELECT * FROM products;\nSELECT * FROM nope;\nSELECT 1;";

    await settle(useResultStore.getState().executeQuery(conn.id, script, "shop"));

    const state = useResultStore.getState();
    expect(state.error).toBe("Table 'shop.nope' doesn't exist");
    expect(state.failedStatement).toEqual({ index: 1, count: 3, sql: "SELECT * FROM nope", code: 1146 });
    expect(state.results).toHaveLength(1);
    expect(state.results[0].sql).toBe("SELECT * FROM products");
    expect(state.results[0].rows.length).toBeGreaterThan(0);
    expect(state.resultSource?.connectionId).toBe(conn.id);
  });
});
