import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStorageErrorStore } from "../storageErrorStore";

describe("storageErrorStore", () => {
  beforeEach(() => {
    useStorageErrorStore.setState({ errors: {} });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("describes a quota failure", () => {
    useStorageErrorStore
      .getState()
      .reportStorageError("theme", new DOMException("quota", "QuotaExceededError"), "theme");

    expect(useStorageErrorStore.getState().errors.theme).toMatch(/quota exceeded/i);
  });

  it("describes blocked storage separately from quota", () => {
    useStorageErrorStore
      .getState()
      .reportStorageError("theme", new DOMException("nope", "SecurityError"), "theme");

    expect(useStorageErrorStore.getState().errors.theme).toMatch(/private mode|cookies/i);
  });

  it("falls back to the raw message for an unrecognised error", () => {
    useStorageErrorStore.getState().reportStorageError("theme", new Error("disk on fire"), "theme");
    expect(useStorageErrorStore.getState().errors.theme).toMatch(/disk on fire/);
  });

  it("logs a warning so failures are visible without the StatusBar", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useStorageErrorStore.getState().reportStorageError("theme", new Error("x"), "theme");
    expect(warn).toHaveBeenCalled();
  });

  it("clears a key when passed null", () => {
    const { reportStorageError } = useStorageErrorStore.getState();
    reportStorageError("theme", new Error("x"), "theme");
    reportStorageError("theme", null, "theme");
    expect(useStorageErrorStore.getState().errors.theme).toBeUndefined();
  });

  it("keeps keys independent", () => {
    const { reportStorageError } = useStorageErrorStore.getState();
    reportStorageError("theme", new Error("x"), "theme");
    reportStorageError("query-settings", new Error("y"), "query settings");

    reportStorageError("theme", null, "theme");

    expect(useStorageErrorStore.getState().errors.theme).toBeUndefined();
    expect(useStorageErrorStore.getState().errors["query-settings"]).toBeDefined();
  });

  it("dismisses a single key", () => {
    const { reportStorageError, dismissStorageError } = useStorageErrorStore.getState();
    reportStorageError("theme", new Error("x"), "theme");
    dismissStorageError("theme");
    expect(useStorageErrorStore.getState().errors.theme).toBeUndefined();
  });
});
