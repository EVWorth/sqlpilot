import { beforeEach, describe, expect, it } from "vitest";
import {
  hasOpenTransaction,
  hasOpenTransactionForTab,
  tabTransactionOpen,
  useTransactionStore,
} from "../transactionStore";

describe("transactionStore", () => {
  beforeEach(() => useTransactionStore.setState({ open: {}, openConnections: {} }));

  describe("per tab (#843)", () => {
    it("sets, clears and forgets a tab's flag", () => {
      useTransactionStore.getState().setOpen("tab-1", true);
      useTransactionStore.getState().setOpen("tab-2", true);
      expect(hasOpenTransaction("tab-1")).toBe(true);

      useTransactionStore.getState().setOpen("tab-1", false);
      useTransactionStore.getState().forget(["tab-2"]);

      expect(useTransactionStore.getState().open).toEqual({});
    });
  });

  // #935: a SQLite file has one connection, shared by every tab on it.
  describe("per shared connection (#935)", () => {
    it("sets and clears a connection's flag", () => {
      useTransactionStore.getState().setConnectionOpen("lite-1", true);
      expect(useTransactionStore.getState().openConnections).toEqual({ "lite-1": true });

      useTransactionStore.getState().setConnectionOpen("lite-1", false);
      expect(useTransactionStore.getState().openConnections).toEqual({});
    });

    it("leaves the state untouched when nothing changes", () => {
      useTransactionStore.getState().setConnectionOpen("lite-1", true);
      const before = useTransactionStore.getState().openConnections;

      useTransactionStore.getState().setConnectionOpen("lite-1", true);
      useTransactionStore.getState().forgetConnection("lite-2");

      expect(useTransactionStore.getState().openConnections).toBe(before);
    });

    it("forgets one connection and keeps the others", () => {
      useTransactionStore.getState().setConnectionOpen("lite-1", true);
      useTransactionStore.getState().setConnectionOpen("lite-2", true);

      useTransactionStore.getState().forgetConnection("lite-1");

      expect(useTransactionStore.getState().openConnections).toEqual({ "lite-2": true });
    });

    it("does not touch the per-tab flags", () => {
      useTransactionStore.getState().setOpen("tab-1", true);
      useTransactionStore.getState().setConnectionOpen("lite-1", true);
      useTransactionStore.getState().forgetConnection("lite-1");

      expect(useTransactionStore.getState().open).toEqual({ "tab-1": true });
    });
  });

  describe("hasOpenTransactionForTab", () => {
    it("is true for every tab bound to a connection with a transaction open", () => {
      useTransactionStore.getState().setConnectionOpen("lite-1", true);

      expect(hasOpenTransactionForTab({ id: "tab-1", connectionId: "lite-1" })).toBe(true);
      expect(hasOpenTransactionForTab({ id: "tab-2", connectionId: "lite-1" })).toBe(true);
      expect(hasOpenTransactionForTab({ id: "tab-3", connectionId: "lite-2" })).toBe(false);
      expect(hasOpenTransactionForTab({ id: "tab-4", connectionId: undefined })).toBe(false);
    });

    it("is true for a tab whose own session has one, and only that tab", () => {
      useTransactionStore.getState().setOpen("tab-1", true);

      expect(hasOpenTransactionForTab({ id: "tab-1", connectionId: "conn-1" })).toBe(true);
      expect(hasOpenTransactionForTab({ id: "tab-2", connectionId: "conn-1" })).toBe(false);
      // The per-tab read is unchanged.
      expect(hasOpenTransaction("tab-2")).toBe(false);
    });

    it("reads the same from a snapshot, for a selector", () => {
      const flags = { open: {}, openConnections: { "lite-1": true as const } };
      expect(tabTransactionOpen(flags, { id: "tab-9", connectionId: "lite-1" })).toBe(true);
      expect(tabTransactionOpen(flags, { id: "tab-9", connectionId: "conn-1" })).toBe(false);
    });
  });
});
