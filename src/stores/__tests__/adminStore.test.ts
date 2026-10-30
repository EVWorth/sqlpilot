import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getProcessList: vi.fn(),
  getOwnThreadIds: vi.fn(),
  killQuery: vi.fn(),
  killProcess: vi.fn(),
  getServerVariables: vi.fn(),
  executeQuery: vi.fn(),
  getDatabases: vi.fn(),
}));

vi.mock("../../lib/tauri-api", () => ({ api }));

import { grantsOf, processListOf, useAdminStore, variablesOf } from "../adminStore";
import { useConnectionStore } from "../connectionStore";
import { useHistoryStore } from "../historyStore";

const process = { id: 7, user: "app", command: "Query", time: 3 };

function grantRows(...lines: string[]) {
  return [{ columns: [], rows: lines.map((l) => [l]) }];
}

describe("adminStore", () => {
  beforeEach(() => {
    useAdminStore.setState({ processLists: {}, variables: {}, grants: {} });
    for (const fn of Object.values(api)) fn.mockReset();
  });

  describe("process list", () => {
    it("is loading until the first read, then holds the list and the app's own sessions", async () => {
      expect(processListOf(useAdminStore.getState(), "v1").loading).toBe(true);
      api.getProcessList.mockResolvedValue([process]);
      api.getOwnThreadIds.mockResolvedValue([7]);

      await useAdminStore.getState().loadProcesses("v1", "conn-1");

      expect(api.getProcessList).toHaveBeenCalledWith("conn-1");
      expect(processListOf(useAdminStore.getState(), "v1")).toEqual({
        processes: [process],
        ownThreadIds: [7],
        loading: false,
        error: null,
      });
    });

    it("keeps the last list and says why a refresh failed", async () => {
      api.getProcessList.mockResolvedValueOnce([process]).mockRejectedValueOnce("Lost connection");
      api.getOwnThreadIds.mockResolvedValue([]);
      const store = useAdminStore.getState();

      await store.loadProcesses("v1", "conn-1");
      await store.loadProcesses("v1", "conn-1", { background: true });

      expect(processListOf(useAdminStore.getState(), "v1")).toMatchObject({
        processes: [process],
        error: "Lost connection",
        loading: false,
      });
    });

    it("leaves loading alone on a background refresh", async () => {
      let finish: (v: unknown) => void = () => {};
      api.getProcessList.mockResolvedValueOnce([process]).mockReturnValueOnce(new Promise((r) => (finish = r)));
      api.getOwnThreadIds.mockResolvedValue([]);
      const store = useAdminStore.getState();
      await store.loadProcesses("v1", "conn-1");

      const pending = store.loadProcesses("v1", "conn-1", { background: true });
      expect(processListOf(useAdminStore.getState(), "v1").loading).toBe(false);
      finish([]);
      await pending;
    });

    it("kills only the statement, or the whole connection", async () => {
      api.killQuery.mockResolvedValue(null);
      api.killProcess.mockResolvedValue(null);
      const store = useAdminStore.getState();

      expect(await store.killProcess("v1", "conn-1", 7, "query")).toBe(true);
      expect(api.killQuery).toHaveBeenCalledWith("conn-1", 7);
      expect(api.killProcess).not.toHaveBeenCalled();

      expect(await store.killProcess("v1", "conn-1", 8, "connection")).toBe(true);
      expect(api.killProcess).toHaveBeenCalledWith("conn-1", 8);
    });

    it("says which kill failed", async () => {
      api.getProcessList.mockResolvedValue([process]);
      api.getOwnThreadIds.mockResolvedValue([]);
      api.killQuery.mockRejectedValue("Unknown thread id: 7");
      await useAdminStore.getState().loadProcesses("v1", "conn-1");

      expect(await useAdminStore.getState().killProcess("v1", "conn-1", 7, "query")).toBe(false);

      expect(processListOf(useAdminStore.getState(), "v1").error).toBe(
        "Failed to kill query on 7: Unknown thread id: 7",
      );
    });
  });

  describe("server variables", () => {
    it("holds the variables, or why they could not be read", async () => {
      api.getServerVariables.mockResolvedValueOnce([{ name: "max_connections", value: "151" }])
        .mockRejectedValueOnce("denied");
      const store = useAdminStore.getState();

      await store.loadVariables("v1", "conn-1");
      expect(variablesOf(useAdminStore.getState(), "v1")).toEqual({
        variables: [{ name: "max_connections", value: "151" }],
        loading: false,
        error: null,
      });

      await store.loadVariables("v1", "conn-1", { background: true });
      expect(variablesOf(useAdminStore.getState(), "v1")).toMatchObject({
        variables: [{ name: "max_connections", value: "151" }],
        error: "denied",
      });
    });

    it("does not let an answer for a connection the tab left land", async () => {
      let resolveOld: (v: unknown) => void = () => {};
      api.getServerVariables
        .mockReturnValueOnce(new Promise((r) => (resolveOld = r)))
        .mockResolvedValueOnce([{ name: "new", value: "1" }]);
      const store = useAdminStore.getState();

      const old = store.loadVariables("v1", "conn-old");
      await store.loadVariables("v1", "conn-new");
      resolveOld([{ name: "old", value: "1" }]);
      await old;

      expect(variablesOf(useAdminStore.getState(), "v1").variables).toEqual([{ name: "new", value: "1" }]);
    });
  });

  describe("grants", () => {
    it("reads the account's grants, quoting user and host", async () => {
      api.executeQuery.mockResolvedValue(grantRows("GRANT USAGE ON *.* TO `o'neil`@`%`"));

      await useAdminStore.getState().loadGrants("v1", "conn-1", "o'neil", "%");

      expect(api.executeQuery).toHaveBeenCalledWith("conn-1", "SHOW GRANTS FOR 'o''neil'@'%'", undefined);
      expect(grantsOf(useAdminStore.getState(), "v1")).toEqual({
        grants: ["GRANT USAGE ON *.* TO `o'neil`@`%`"],
        loading: false,
        error: null,
      });
    });

    it("says why the grants could not be read", async () => {
      api.executeQuery.mockRejectedValue("There is no such grant defined");

      await useAdminStore.getState().loadGrants("v1", "conn-1", "app", "%");

      expect(grantsOf(useAdminStore.getState(), "v1")).toMatchObject({
        error: "There is no such grant defined",
        loading: false,
      });
    });

    it("records every grant read as internal, the account view's and the editor's alike (#921)", async () => {
      const addEntry = vi.fn().mockResolvedValue(undefined);
      useHistoryStore.setState({ addEntry });
      useConnectionStore.setState({
        activeConnections: [{ id: "conn-1", name: "Local" }],
      } as unknown as Partial<ReturnType<typeof useConnectionStore.getState>>);
      api.executeQuery.mockResolvedValue(grantRows("GRANT USAGE ON *.* TO `app`@`%`"));
      const store = useAdminStore.getState();

      await store.loadGrants("v1", "conn-1", "app", "%");
      await store.showGrants("conn-1", "app", "%");

      expect(addEntry).toHaveBeenCalledTimes(2);
      for (const [entry] of addEntry.mock.calls) {
        expect(entry).toMatchObject({ sql: "SHOW GRANTS FOR 'app'@'%'", origin: "internal" });
      }
      useConnectionStore.setState({ activeConnections: [] });
    });

    it("hands the grant lines to a caller that keeps them, or null without a result set", async () => {
      api.executeQuery.mockResolvedValueOnce(grantRows("GRANT SELECT ON `shop`.* TO `app`@`%`"))
        .mockResolvedValueOnce([]);
      const store = useAdminStore.getState();

      expect(await store.showGrants("conn-1", "app", "%")).toEqual(["GRANT SELECT ON `shop`.* TO `app`@`%`"]);
      expect(await store.showGrants("conn-1", "app", "%")).toBeNull();
    });
  });

  it("lists database names", async () => {
    api.getDatabases.mockResolvedValue([{ name: "shop" }, { name: "sys" }]);

    expect(await useAdminStore.getState().listDatabaseNames("conn-1")).toEqual(["shop", "sys"]);
  });

  describe("release", () => {
    it("drops a view's entries and ignores its late answers", async () => {
      let finish: (v: unknown) => void = () => {};
      api.getServerVariables.mockReturnValue(new Promise((r) => (finish = r)));
      api.getProcessList.mockResolvedValue([]);
      api.getOwnThreadIds.mockResolvedValue([]);
      api.killQuery.mockRejectedValue("gone");
      const store = useAdminStore.getState();
      await store.loadProcesses("v1", "conn-1");
      const pending = store.loadVariables("v1", "conn-1");

      store.release("v1");
      finish([{ name: "late", value: "1" }]);
      await pending;
      await store.killProcess("v1", "conn-1", 7, "query");

      const state = useAdminStore.getState();
      expect(state.processLists).toEqual({});
      expect(state.variables).toEqual({});
      expect(state.grants).toEqual({});
    });
  });
});
