import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStorageErrorStore } from "../../stores/storageErrorStore";
import { saveSession } from "../editor-session";

const tab = {
  id: "tab-1",
  title: "Untitled Query",
  content: "SELECT 1",
  isDirty: true,
  type: "query" as const,
};

describe("saving the editor session", () => {
  beforeEach(() => {
    useStorageErrorStore.setState({ errors: {} });
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("writes the tabs and which one was in front", () => {
    saveSession([tab], "tab-1");

    const written = JSON.parse(localStorage.getItem("sqlpilot-editor-session")!);
    expect(written.activeTabId).toBe("tab-1");
    expect(written.tabs[0].content).toBe("SELECT 1");
  });

  it("says so when the write fails", () => {
    // It used to swallow this. Of everything kept in localStorage the session
    // is the one whose loss is most visible: a dozen tabs of unsaved SQL, gone
    // after a restart, with nothing having said saving had stopped working.
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    saveSession([tab], "tab-1");

    const message = useStorageErrorStore.getState().errors["editor-session"];
    expect(message).toContain("open tabs");
    expect(message).toContain("quota");
  });

  it("clears the warning once a write succeeds again", () => {
    // Closing a tab can bring the session back under the quota, and a stale
    // warning would say the opposite.
    const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    saveSession([tab], "tab-1");
    expect(useStorageErrorStore.getState().errors["editor-session"]).toBeDefined();

    spy.mockRestore();
    saveSession([tab], "tab-1");

    expect(useStorageErrorStore.getState().errors["editor-session"]).toBeUndefined();
  });

  it("does not throw when storage is unavailable altogether", () => {
    // Private mode, or storage disabled: the app has to keep working.
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(() => saveSession([tab], "tab-1")).not.toThrow();
    expect(useStorageErrorStore.getState().errors["editor-session"])
      .toContain("private mode");
  });
});
