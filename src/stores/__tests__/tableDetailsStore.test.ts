import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getColumns: vi.fn(),
  getIndexes: vi.fn(),
  getForeignKeys: vi.fn(),
  getPartitions: vi.fn(),
  getTableDdl: vi.fn(),
  getTables: vi.fn(),
}));

vi.mock("../../lib/tauri-api", () => ({ api }));

import { referencesOf, useTableDetailsStore } from "../tableDetailsStore";

const target = { connectionId: "conn-1", database: "shop", table: "orders" };
const column = { name: "id", column_type: "int" };

describe("tableDetailsStore", () => {
  beforeEach(() => {
    useTableDetailsStore.setState({ details: {}, references: {} });
    for (const fn of Object.values(api)) fn.mockReset();
  });

  describe("loadDetails", () => {
    it("reads only the parts asked for and stores them under the view", async () => {
      api.getColumns.mockResolvedValue([column]);
      api.getTableDdl.mockResolvedValue("CREATE TABLE orders (id int)");

      const details = await useTableDetailsStore.getState().loadDetails("v1", target, ["columns", "ddl"]);

      expect(api.getColumns).toHaveBeenCalledWith("conn-1", "shop", "orders");
      expect(api.getIndexes).not.toHaveBeenCalled();
      expect(api.getPartitions).not.toHaveBeenCalled();
      expect(details.columns).toEqual([column]);
      expect(details.ddl).toBe("CREATE TABLE orders (id int)");
      expect(details.errors).toEqual({});
      expect(useTableDetailsStore.getState().details.v1).toEqual({ details, loading: false });
    });

    it("keeps the parts that loaded when one fails", async () => {
      api.getColumns.mockResolvedValue([column]);
      api.getPartitions.mockRejectedValue("PARTITIONS denied");

      const details = await useTableDetailsStore.getState().loadDetails("v1", target, ["columns", "partitions"]);

      expect(details.columns).toEqual([column]);
      expect(details.partitions).toEqual([]);
      expect(details.errors).toEqual({ partitions: "PARTITIONS denied" });
    });

    it("is loading while the reads are in flight", async () => {
      let resolve: (v: unknown) => void = () => {};
      api.getColumns.mockReturnValue(new Promise((r) => (resolve = r)));

      const pending = useTableDetailsStore.getState().loadDetails("v1", target, ["columns"]);
      expect(useTableDetailsStore.getState().details.v1?.loading).toBe(true);

      resolve([]);
      await pending;
      expect(useTableDetailsStore.getState().details.v1?.loading).toBe(false);
    });

    it("does not let a superseded read land on top of a later one", async () => {
      let resolveFirst: (v: unknown) => void = () => {};
      api.getColumns
        .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
        .mockResolvedValueOnce([{ name: "fresh", column_type: "int" }]);
      const store = useTableDetailsStore.getState();

      const first = store.loadDetails("v1", target, ["columns"]);
      await store.loadDetails("v1", target, ["columns"]);
      resolveFirst([{ name: "stale", column_type: "int" }]);
      await first;

      expect(useTableDetailsStore.getState().details.v1?.details?.columns).toEqual([
        { name: "fresh", column_type: "int" },
      ]);
    });

    it("keeps two views of the same table apart", async () => {
      api.getColumns.mockResolvedValueOnce([column]).mockRejectedValueOnce("denied");
      const store = useTableDetailsStore.getState();

      await store.loadDetails("v1", target, ["columns"]);
      await store.loadDetails("v2", target, ["columns"]);

      const { details } = useTableDetailsStore.getState();
      expect(details.v1?.details?.columns).toEqual([column]);
      expect(details.v2?.details?.errors.columns).toBe("denied");
    });
  });

  describe("references", () => {
    it("holds the reference tables", async () => {
      api.getTables.mockResolvedValue([{ name: "customers" }]);

      await useTableDetailsStore.getState().loadReferenceTables("v1", "conn-1", "shop");

      expect(api.getTables).toHaveBeenCalledWith("conn-1", "shop");
      expect(referencesOf(useTableDetailsStore.getState(), "v1").tables).toEqual([{ name: "customers" }]);
    });

    it("reads a reference table's columns once per view", async () => {
      api.getColumns.mockResolvedValue([column]);
      const store = useTableDetailsStore.getState();

      await store.loadReferenceColumns("v1", target);
      await store.loadReferenceColumns("v1", target);

      expect(api.getColumns).toHaveBeenCalledTimes(1);
      expect(referencesOf(useTableDetailsStore.getState(), "v1").columns.orders).toEqual([column]);
    });

    it("says why a reference table's columns failed, and retries", async () => {
      api.getColumns.mockRejectedValueOnce(new Error("SELECT denied")).mockResolvedValueOnce([column]);
      const store = useTableDetailsStore.getState();

      await store.loadReferenceColumns("v1", target);
      // Without the "Error: " prefix String(e) would add (#804).
      expect(referencesOf(useTableDetailsStore.getState(), "v1").columnErrors).toEqual({ orders: "SELECT denied" });

      await store.loadReferenceColumns("v1", target);
      const refs = referencesOf(useTableDetailsStore.getState(), "v1");
      expect(refs.columns.orders).toEqual([column]);
      expect(refs.columnErrors).toEqual({});
    });
  });

  describe("release", () => {
    it("drops what a view held", async () => {
      api.getColumns.mockResolvedValue([column]);
      api.getTables.mockResolvedValue([]);
      const store = useTableDetailsStore.getState();
      await store.loadDetails("v1", target, ["columns"]);
      await store.loadReferenceTables("v1", "conn-1", "shop");

      store.release("v1");

      expect(useTableDetailsStore.getState().details).toEqual({});
      expect(useTableDetailsStore.getState().references).toEqual({});
    });

    it("does not bring a view back when its reads land after it was released", async () => {
      let resolveColumns: (v: unknown) => void = () => {};
      let resolveTables: (v: unknown) => void = () => {};
      api.getColumns.mockReturnValue(new Promise((r) => (resolveColumns = r)));
      api.getTables.mockReturnValue(new Promise((r) => (resolveTables = r)));
      const store = useTableDetailsStore.getState();

      const details = store.loadDetails("v1", target, ["columns"]);
      const tables = store.loadReferenceTables("v1", "conn-1", "shop");
      store.release("v1");
      resolveColumns([column]);
      resolveTables([{ name: "customers" }]);
      await Promise.all([details, tables]);

      expect(useTableDetailsStore.getState().details).toEqual({});
      expect(useTableDetailsStore.getState().references).toEqual({});
    });
  });
});
