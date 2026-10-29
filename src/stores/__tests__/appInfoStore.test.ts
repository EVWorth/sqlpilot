import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getAppVersion: vi.fn(),
  keyringAvailable: vi.fn(),
  startupProblems: vi.fn(),
}));

vi.mock("../../lib/tauri-api", () => ({ api }));

import { useAppInfoStore } from "../appInfoStore";

const problem = { kind: "history-store", summary: "History could not be opened.", detail: "malformed" };

describe("appInfoStore", () => {
  beforeEach(() => {
    useAppInfoStore.setState(useAppInfoStore.getInitialState());
    for (const fn of Object.values(api)) fn.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("knows nothing until asked", () => {
    expect(useAppInfoStore.getState()).toMatchObject({
      appVersion: "",
      keyringAvailable: undefined,
      startupProblems: [],
    });
  });

  it("holds what each read answered", async () => {
    api.getAppVersion.mockResolvedValue("2.1.0");
    api.keyringAvailable.mockResolvedValue(false);
    api.startupProblems.mockResolvedValue([problem]);
    const store = useAppInfoStore.getState();

    await Promise.all([store.loadAppVersion(), store.checkKeyring(), store.loadStartupProblems()]);

    expect(useAppInfoStore.getState()).toMatchObject({
      appVersion: "2.1.0",
      keyringAvailable: false,
      startupProblems: [problem],
    });
  });

  it("stays quiet and unchanged when a read fails", async () => {
    // None of these failing says anything the user can act on: a keyring
    // check that cannot run is not a missing keyring.
    api.getAppVersion.mockRejectedValue(new Error("no backend"));
    api.keyringAvailable.mockRejectedValue(new Error("no backend"));
    api.startupProblems.mockRejectedValue(new Error("no backend"));
    const store = useAppInfoStore.getState();

    await Promise.all([store.loadAppVersion(), store.checkKeyring(), store.loadStartupProblems()]);

    expect(useAppInfoStore.getState()).toMatchObject({
      appVersion: "",
      keyringAvailable: undefined,
      startupProblems: [],
    });
  });
});
