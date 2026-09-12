import { beforeEach, describe, expect, it, vi } from "vitest";

const connectionState = {
  activeConnections: [] as { id: string; profile_id: string }[],
  profiles: [] as { id: string; environment?: string }[],
};

vi.mock("../connectionStore", () => ({
  useConnectionStore: { getState: () => connectionState },
}));

import {
  confirmDestructive,
  confirmDrop,
  isProductionConnection,
  useProductionGuardStore,
} from "../productionGuardStore";

/** Point `conn` at a profile in the given environment. */
function connectAs(environment: string) {
  connectionState.activeConnections = [{ id: "conn", profile_id: "p" }];
  connectionState.profiles = [{ id: "p", environment }];
}

/** Answer whatever question is currently open. */
function answer(confirmed: boolean) {
  useProductionGuardStore.getState().answer(confirmed);
}

describe("productionGuardStore", () => {
  beforeEach(() => {
    useProductionGuardStore.setState({ pending: null, resolve: null });
    connectionState.activeConnections = [];
    connectionState.profiles = [];
  });

  describe("isProductionConnection", () => {
    it("is true only for a profile marked production", () => {
      connectAs("production");
      expect(isProductionConnection("conn")).toBe(true);

      connectAs("staging");
      expect(isProductionConnection("conn")).toBe(false);
    });

    it("is false for a connection it cannot find", () => {
      expect(isProductionConnection("nope")).toBe(false);
    });
  });

  describe("confirmDestructive", () => {
    it("does not ask on a non-production connection", async () => {
      connectAs("staging");

      await expect(confirmDestructive({
        connectionId: "conn",
        sql: "DROP TABLE users",
        action: "Drop it?",
      })).resolves.toBe(true);
      expect(useProductionGuardStore.getState().pending).toBeNull();
    });

    it("does not ask about a statement that only reads", async () => {
      connectAs("production");

      await expect(confirmDestructive({
        connectionId: "conn",
        sql: "SELECT * FROM users",
        action: "Read it?",
      })).resolves.toBe(true);
      expect(useProductionGuardStore.getState().pending).toBeNull();
    });

    it("asks before a destructive statement on production", async () => {
      connectAs("production");

      const pending = confirmDestructive({
        connectionId: "conn",
        sql: "DROP TABLE users",
        action: "Drop `users`?",
      });

      expect(useProductionGuardStore.getState().pending?.message).toContain("Drop `users`?");
      answer(true);
      await expect(pending).resolves.toBe(true);
    });

    it("resolves false when the user declines, so the caller can stop", async () => {
      connectAs("production");

      const pending = confirmDestructive({
        connectionId: "conn",
        sql: "DROP TABLE users",
        action: "Drop `users`?",
      });
      answer(false);

      await expect(pending).resolves.toBe(false);
      expect(useProductionGuardStore.getState().pending).toBeNull();
    });

    it("asks once for a batch, not once per statement", async () => {
      connectAs("production");
      const statements = ["UPDATE t SET a = 1", "DROP TABLE u", "DELETE FROM v"];

      const pending = confirmDestructive({
        connectionId: "conn",
        sql: statements,
        action: "Import 3 statements?",
      });

      expect(useProductionGuardStore.getState().pending).not.toBeNull();
      answer(true);
      await expect(pending).resolves.toBe(true);
    });

    it("asks about a batch where only one statement is destructive", async () => {
      connectAs("production");

      const pending = confirmDestructive({
        connectionId: "conn",
        sql: ["INSERT INTO t VALUES (1)", "TRUNCATE TABLE u"],
        action: "Run them?",
      });

      expect(useProductionGuardStore.getState().pending).not.toBeNull();
      answer(true);
      await pending;
    });

    it("asks about an ordinary write when alwaysAsk is set", async () => {
      connectAs("production");

      const pending = confirmDestructive({
        connectionId: "conn",
        sql: ["UPDATE orders SET total = 1 WHERE id = 2"],
        action: "Apply 1 change?",
        alwaysAsk: true,
      });

      expect(useProductionGuardStore.getState().pending).not.toBeNull();
      answer(true);
      await expect(pending).resolves.toBe(true);
    });

    it("still skips a non-production connection under alwaysAsk", async () => {
      connectAs("development");

      await expect(confirmDestructive({
        connectionId: "conn",
        sql: ["UPDATE orders SET total = 1"],
        action: "Apply?",
        alwaysAsk: true,
      })).resolves.toBe(true);
    });

    it("includes the detail line in the message", async () => {
      connectAs("production");

      const pending = confirmDestructive({
        connectionId: "conn",
        sql: "DELETE FROM t",
        action: "Apply 2 change(s)?",
        detail: "2 row(s) deleted",
      });

      expect(useProductionGuardStore.getState().pending?.message).toContain("2 row(s) deleted");
      answer(true);
      await pending;
    });

    it("declines an earlier question rather than stranding its caller", async () => {
      connectAs("production");

      const first = confirmDestructive({
        connectionId: "conn",
        sql: "DROP TABLE a",
        action: "First?",
      });
      const second = confirmDestructive({
        connectionId: "conn",
        sql: "DROP TABLE b",
        action: "Second?",
      });

      // The first caller gets an answer — no — rather than waiting for ever.
      await expect(first).resolves.toBe(false);
      expect(useProductionGuardStore.getState().pending?.message).toContain("Second?");

      answer(true);
      await expect(second).resolves.toBe(true);
    });
  });
});

describe("confirmDrop (routine audit F9)", () => {
  beforeEach(() => {
    useProductionGuardStore.setState({ pending: null, resolve: null });
    connectionState.activeConnections = [];
    connectionState.profiles = [];
  });

  it("asks in the app's own dialog on an ordinary connection", async () => {
    const pending = confirmDrop("conn-dev", "view `shop`.`v`");
    await Promise.resolve();

    const request = useProductionGuardStore.getState().pending;
    expect(request?.confirmLabel).toBe("Drop");
    expect(request?.message).toContain("view `shop`.`v`");

    useProductionGuardStore.getState().answer(true);
    expect(await pending).toBe(true);
  });

  it("resolves false when the dialog is declined", async () => {
    const pending = confirmDrop("conn-dev", "trigger `t`");
    await Promise.resolve();
    useProductionGuardStore.getState().answer(false);
    expect(await pending).toBe(false);
  });

  it("stays out of the way on production, where the stronger gate asks", async () => {
    // The drop runs through resultStore, whose production dialog names the
    // statement. Two confirmations for one click is worse than one.
    connectAs("production");

    await expect(confirmDrop("conn", "procedure `p`")).resolves.toBe(true);
    expect(useProductionGuardStore.getState().pending).toBeNull();
  });
});
