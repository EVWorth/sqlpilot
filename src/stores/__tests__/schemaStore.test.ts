import { beforeEach, describe, expect, it, vi } from "vitest";
import { dataSourceFor } from "../../lib/datasource";
import { loadKey, schemaFor, useSchemaStore } from "../schemaStore";

vi.mock("../../lib/datasource", () => ({ dataSourceFor: vi.fn() }));

const listDatabases = vi.fn();
const listTables = vi.fn();
const listViews = vi.fn();
const listRoutines = vi.fn();
const listTriggers = vi.fn();
const getColumns = vi.fn();

const db = (name: string) => ({ name, default_charset: "utf8mb4", default_collation: "utf8mb4_0900_ai_ci" });
const table = (name: string) => ({
  name,
  table_type: "BASE TABLE",
  engine: "InnoDB",
  row_count: 0,
  data_size: 0,
  comment: "",
});

/** A promise the test decides when to settle. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("schemaStore (#288, #289)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSchemaStore.setState({ byConnection: {} });
    vi.mocked(dataSourceFor).mockReturnValue({
      listDatabases,
      listTables,
      listViews,
      listRoutines,
      listTriggers,
      getColumns,
    } as never);
    listDatabases.mockResolvedValue([db("app")]);
    listTables.mockResolvedValue([table("users")]);
    listViews.mockResolvedValue([{ name: "v1" }]);
    listRoutines.mockResolvedValue([{ name: "p1" }]);
    listTriggers.mockResolvedValue([{ name: "t1" }]);
    getColumns.mockResolvedValue([{ name: "id" }]);
  });

  const store = () => useSchemaStore.getState();
  const cached = (connectionId: string) => schemaFor(useSchemaStore.getState(), connectionId);

  describe("keyed by connection", () => {
    it("keeps two servers' databases of the same name apart", async () => {
      // `mysql` and `app` are on nearly every server, which is what made this
      // show up as one server's tables in the other's tree.
      listTables.mockImplementation((connectionId: string) =>
        Promise.resolve([table(connectionId === "a" ? "users" : "orders")])
      );

      await store().ensureTables("a", "app");
      await store().ensureTables("b", "app");

      expect(cached("a").tables.app.map((t) => t.name)).toEqual(["users"]);
      expect(cached("b").tables.app.map((t) => t.name)).toEqual(["orders"]);
    });

    it("knows nothing about a connection it has not been asked about", () => {
      expect(cached("unknown").tables).toEqual({});
      expect(cached("unknown").databases).toBeUndefined();
    });

    it("returns one shared object for every unknown connection", () => {
      // A fresh object per call would compare unequal on every render and
      // re-render the tree forever.
      expect(cached("one")).toBe(cached("two"));
    });
  });

  describe("caching", () => {
    it("fetches once and serves the rest from memory", async () => {
      await store().ensureTables("a", "app");
      await store().ensureTables("a", "app");

      expect(listTables).toHaveBeenCalledTimes(1);
    });

    it("caches an empty result rather than re-asking forever", async () => {
      // A database with no views is an answer, not a miss.
      listViews.mockResolvedValue([]);

      await store().ensureViews("a", "app");
      await store().ensureViews("a", "app");

      expect(listViews).toHaveBeenCalledTimes(1);
    });

    it("keys columns by table as well as database", async () => {
      await store().ensureColumns("a", "app", "users");
      await store().ensureColumns("a", "app", "orders");

      expect(Object.keys(cached("a").columns).sort()).toEqual(["app.orders", "app.users"]);
    });

    it("does not cache a failure", async () => {
      listTables.mockRejectedValueOnce(new Error("connection lost"));
      vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await store().ensureTables("a", "app")).toEqual([]);
      expect(cached("a").tables.app).toBeUndefined();

      await store().ensureTables("a", "app");
      expect(listTables).toHaveBeenCalledTimes(2);
    });
  });

  describe("late responses", () => {
    it("drops one that arrives after the cache was invalidated", async () => {
      // This is what repopulated a new tree with the old server's objects.
      const slow = deferred<ReturnType<typeof table>[]>();
      listTables.mockReturnValueOnce(slow.promise);
      const inFlight = store().ensureTables("a", "app");

      store().invalidate("a");
      slow.resolve([table("stale")]);
      await inFlight;

      expect(cached("a").tables.app).toBeUndefined();
    });

    it("drops one that arrives after the connection was forgotten", async () => {
      const slow = deferred<ReturnType<typeof table>[]>();
      listTables.mockReturnValueOnce(slow.promise);
      const inFlight = store().ensureTables("a", "app");

      store().forget("a");
      slow.resolve([table("stale")]);
      await inFlight;

      expect(cached("a").tables.app).toBeUndefined();
    });

    it("still hands the caller what it asked for", async () => {
      // The answer is not wrong, it is merely no longer wanted; the caller
      // asked and deserves a reply.
      const slow = deferred<ReturnType<typeof table>[]>();
      listTables.mockReturnValueOnce(slow.promise);
      const inFlight = store().ensureTables("a", "app");

      store().invalidate("a");
      slow.resolve([table("late")]);

      expect((await inFlight).map((t) => t.name)).toEqual(["late"]);
    });
  });

  describe("invalidating", () => {
    beforeEach(async () => {
      await store().ensureDatabases("a");
      for (const database of ["app", "shop"]) {
        await store().ensureTables("a", database);
        await store().ensureViews("a", database);
        await store().ensureRoutines("a", database);
        await store().ensureTriggers("a", database);
        await store().ensureColumns("a", database, "users");
      }
    });

    it("a whole connection drops everything", () => {
      store().invalidate("a");

      expect(cached("a").databases).toBeUndefined();
      expect(cached("a").tables).toEqual({});
      expect(cached("a").columns).toEqual({});
    });

    it("a database drops every folder under it, not just tables", () => {
      // Reloading only tables is what left views, routines and triggers
      // stale after a refresh (#289).
      store().invalidate("a", "app");

      expect(cached("a").tables.app).toBeUndefined();
      expect(cached("a").views.app).toBeUndefined();
      expect(cached("a").routines.app).toBeUndefined();
      expect(cached("a").triggers.app).toBeUndefined();
      expect(cached("a").columns["app.users"]).toBeUndefined();
    });

    it("a database leaves its siblings alone", () => {
      store().invalidate("a", "app");

      expect(cached("a").tables.shop).toBeDefined();
      expect(cached("a").columns["shop.users"]).toBeDefined();
      expect(cached("a").databases).toBeDefined();
    });

    it.each(["tables", "views", "routines", "triggers"] as const)(
      "a %s folder drops only that folder",
      (folder) => {
        store().invalidate("a", "app", folder);

        expect(cached("a")[folder].app).toBeUndefined();
        for (const other of ["tables", "views", "routines", "triggers"] as const) {
          if (other !== folder) expect(cached("a")[other].app).toBeDefined();
        }
      },
    );

    it("leaves other connections untouched", async () => {
      await store().ensureTables("b", "app");

      store().invalidate("a");

      expect(cached("b").tables.app).toBeDefined();
    });

    it("makes the next read fetch again", async () => {
      store().invalidate("a", "app");
      listTables.mockClear();

      await store().ensureTables("a", "app");

      expect(listTables).toHaveBeenCalledTimes(1);
    });
  });

  describe("loading", () => {
    it("reports a request in flight and then not", async () => {
      const slow = deferred<ReturnType<typeof table>[]>();
      listTables.mockReturnValueOnce(slow.promise);

      const inFlight = store().ensureTables("a", "app");
      expect(store().isLoading("a", loadKey("app"))).toBe(true);

      slow.resolve([table("users")]);
      await inFlight;
      expect(store().isLoading("a", loadKey("app"))).toBe(false);
    });

    it("stops reporting one that failed", async () => {
      listTables.mockRejectedValueOnce(new Error("nope"));
      vi.spyOn(console, "error").mockImplementation(() => {});

      await store().ensureTables("a", "app");

      expect(store().isLoading("a", loadKey("app"))).toBe(false);
    });

    it("keys folders separately from their database", () => {
      expect(loadKey("app")).not.toBe(loadKey("app", "views"));
      expect(loadKey()).toBe("databases");
    });
  });

  describe("forget", () => {
    it("removes everything known about a connection", async () => {
      await store().ensureTables("a", "app");
      await store().ensureTables("b", "app");

      store().forget("a");

      expect(useSchemaStore.getState().byConnection.a).toBeUndefined();
      expect(useSchemaStore.getState().byConnection.b).toBeDefined();
    });
  });
});
