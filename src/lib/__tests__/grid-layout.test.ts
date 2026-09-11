import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyOrder, layoutKey, moveColumn, readLayout, writeLayout } from "../grid-layout";

describe("grid-layout (#392)", () => {
  beforeEach(() => localStorage.clear());

  describe("layoutKey", () => {
    it("keys on the result shape, not the query text", () => {
      // Narrowing the same SELECT is the common case; a query-text key would
      // forget the layout on every WHERE change.
      const a = layoutKey("c1", "shop", ["id", "email"]);
      const b = layoutKey("c1", "shop", ["id", "email"]);
      expect(a).toBe(b);
      expect(a).not.toBeNull();
    });

    it("treats the same names in a different SELECT order as a different query", () => {
      expect(layoutKey("c1", "shop", ["id", "email"]))
        .not.toBe(layoutKey("c1", "shop", ["email", "id"]));
    });

    it("separates connections and databases", () => {
      expect(layoutKey("c1", "shop", ["id"])).not.toBe(layoutKey("c2", "shop", ["id"]));
      expect(layoutKey("c1", "shop", ["id"])).not.toBe(layoutKey("c1", "other", ["id"]));
    });

    it("has no key without a connection or without columns", () => {
      expect(layoutKey(null, "shop", ["id"])).toBeNull();
      expect(layoutKey("c1", "shop", [])).toBeNull();
    });
  });

  describe("storage", () => {
    it("round-trips an order", () => {
      const key = layoutKey("c1", "shop", ["id", "email"]);
      writeLayout(key, { columnOrder: ["email", "id"] });
      expect(readLayout(key)?.columnOrder).toEqual(["email", "id"]);
    });

    it("reads nothing for a key never written", () => {
      expect(readLayout(layoutKey("c1", "shop", ["id"]))).toBeNull();
      expect(readLayout(null)).toBeNull();
    });

    it("ignores stored junk rather than throwing", () => {
      const key = layoutKey("c1", "shop", ["id"])!;
      localStorage.setItem(key, "not json");
      expect(readLayout(key)).toBeNull();
      localStorage.setItem(key, JSON.stringify({ columnOrder: "nope" }));
      expect(readLayout(key)).toBeNull();
    });

    it("survives storage being unavailable", () => {
      // Private browsing and quota errors both throw from the accessor itself.
      const get = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
        throw new Error("denied");
      });
      const set = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("quota");
      });

      const key = layoutKey("c1", "shop", ["id"]);
      expect(() => writeLayout(key, { columnOrder: ["id"] })).not.toThrow();
      expect(readLayout(key)).toBeNull();

      get.mockRestore();
      set.mockRestore();
    });

    it("stops the store growing without bound", () => {
      // A session spent exploring a wide schema leaves one entry per shape.
      for (let i = 0; i < 260; i++) {
        writeLayout(layoutKey("c1", "shop", [`col${i}`]), { columnOrder: [`col${i}`] });
      }
      const mine = Object.keys(localStorage).filter((k) => k.startsWith("sqlpilot.grid-layout:"));
      expect(mine.length).toBeLessThanOrEqual(200);
    });
  });

  describe("applyOrder", () => {
    it("uses the remembered order", () => {
      expect(applyOrder(["email", "id"], ["id", "email"])).toEqual(["email", "id"]);
    });

    it("drops remembered columns the result no longer has", () => {
      expect(applyOrder(["email", "gone", "id"], ["id", "email"])).toEqual(["email", "id"]);
    });

    it("appends new columns rather than resetting the layout", () => {
      // Adding a column to a SELECT should not undo a drag.
      expect(applyOrder(["email", "id"], ["id", "email", "created_at"]))
        .toEqual(["email", "id", "created_at"]);
    });

    it("is the identity when nothing was remembered", () => {
      expect(applyOrder([], ["id", "email"])).toEqual(["id", "email"]);
    });
  });

  describe("moveColumn", () => {
    it("moves a column left into the target's place", () => {
      expect(moveColumn(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    });

    it("moves a column right into the target's place", () => {
      expect(moveColumn(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    });

    it("is a no-op for a column dropped on itself or an unknown name", () => {
      expect(moveColumn(["a", "b"], "a", "a")).toEqual(["a", "b"]);
      expect(moveColumn(["a", "b"], "z", "a")).toEqual(["a", "b"]);
      expect(moveColumn(["a", "b"], "a", "z")).toEqual(["a", "b"]);
    });
  });
});
