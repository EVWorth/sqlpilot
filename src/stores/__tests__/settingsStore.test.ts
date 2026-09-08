import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/tauri-api", () => ({
  api: {
    getPlatformInfo: vi.fn().mockResolvedValue({ package_format: "standard", arch: "x86_64" }),
  },
}));

const QUERY_SETTINGS_KEY = "sqlpilot-query-settings";
const STORAGE_KEY = "sqlpilot-formatter-settings";

const defaultQuerySettings = { maxResultRows: 1000, limitEnabled: true };
const defaultFormatterSettings = {
  keywordCase: "upper" as const,
  identifierCase: "preserve" as const,
  dataTypeCase: "upper" as const,
  functionCase: "preserve" as const,
  indentStyle: "standard" as const,
  tabWidth: 2,
  useTabs: false,
  logicalOperatorNewline: "before" as const,
  newlineBeforeSemicolon: false,
  expressionWidth: 50,
  linesBetweenQueries: 1,
  denseOperators: false,
};

describe("settingsStore", () => {
  describe("loadQuerySettings (initial state)", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it("returns defaults when no localStorage key exists", async () => {
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      expect(useSettingsStore.getState().querySettings).toEqual(defaultQuerySettings);
    });

    it("loads query settings from localStorage", async () => {
      const customSettings = { maxResultRows: 500, limitEnabled: false };
      localStorage.setItem(QUERY_SETTINGS_KEY, JSON.stringify(customSettings));
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      expect(useSettingsStore.getState().querySettings).toEqual(customSettings);
    });

    it("falls back to defaults with corrupt JSON in localStorage", async () => {
      localStorage.setItem(QUERY_SETTINGS_KEY, "{ not valid json }");
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      expect(useSettingsStore.getState().querySettings).toEqual(defaultQuerySettings);
    });

    it("merges partial settings with defaults", async () => {
      const partial = { limitEnabled: false };
      localStorage.setItem(QUERY_SETTINGS_KEY, JSON.stringify(partial));
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      expect(useSettingsStore.getState().querySettings).toEqual({
        ...defaultQuerySettings,
        ...partial,
      });
    });
  });

  describe("loadSettings (initial state)", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it("returns defaults when no localStorage key exists", async () => {
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      expect(useSettingsStore.getState().formatterSettings).toEqual(defaultFormatterSettings);
    });

    it("loads formatter settings from localStorage", async () => {
      const custom = { keywordCase: "lower", tabWidth: 4 };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      expect(useSettingsStore.getState().formatterSettings.keywordCase).toBe("lower");
      expect(useSettingsStore.getState().formatterSettings.tabWidth).toBe(4);
      expect(useSettingsStore.getState().formatterSettings.indentStyle).toBe("standard");
    });

    it("falls back to defaults with corrupt JSON in localStorage", async () => {
      localStorage.setItem(STORAGE_KEY, "corrupt");
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      expect(useSettingsStore.getState().formatterSettings).toEqual(defaultFormatterSettings);
    });

    it("merges partial formatter settings with defaults", async () => {
      const partial = { keywordCase: "lower", expressionWidth: 80 };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(partial));
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      expect(useSettingsStore.getState().formatterSettings.keywordCase).toBe("lower");
      expect(useSettingsStore.getState().formatterSettings.expressionWidth).toBe(80);
      expect(useSettingsStore.getState().formatterSettings.identifierCase).toBe("preserve");
    });
  });

  describe("setQuerySettings", () => {
    beforeEach(() => {
      localStorage.clear();
      useSettingsStoreSetup();
    });

    let useSettingsStore: typeof import("../settingsStore").useSettingsStore;

    async function useSettingsStoreSetup() {
      vi.resetModules();
      const mod = await import("../settingsStore");
      useSettingsStore = mod.useSettingsStore;
    }

    it("persists query settings to localStorage", async () => {
      await useSettingsStoreSetup();
      const newSettings = { maxResultRows: 200, limitEnabled: false };
      useSettingsStore.getState().setQuerySettings(newSettings);

      const stored = localStorage.getItem(QUERY_SETTINGS_KEY);
      expect(stored).toBe(JSON.stringify(newSettings));
    });

    it("updates state with new query settings", async () => {
      await useSettingsStoreSetup();
      const newSettings = { maxResultRows: 5000, limitEnabled: true };
      useSettingsStore.getState().setQuerySettings(newSettings);

      expect(useSettingsStore.getState().querySettings).toEqual(newSettings);
    });
  });

  describe("setFormatterSettings", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it("persists formatter settings to localStorage", async () => {
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      const newSettings = { ...defaultFormatterSettings, tabWidth: 8, useTabs: true };
      useSettingsStore.getState().setFormatterSettings(newSettings);

      const stored = localStorage.getItem(STORAGE_KEY);
      expect(stored).toBe(JSON.stringify(newSettings));
    });

    it("updates state with new formatter settings", async () => {
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      const newSettings = { ...defaultFormatterSettings, keywordCase: "lower" as const };
      useSettingsStore.getState().setFormatterSettings(newSettings);

      expect(useSettingsStore.getState().formatterSettings.keywordCase).toBe("lower");
    });

    it("updates individual formatter fields", async () => {
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      const newSettings = {
        ...defaultFormatterSettings,
        expressionWidth: 120,
        linesBetweenQueries: 3,
        newlineBeforeSemicolon: true,
      };
      useSettingsStore.getState().setFormatterSettings(newSettings);

      const state = useSettingsStore.getState().formatterSettings;
      expect(state.expressionWidth).toBe(120);
      expect(state.linesBetweenQueries).toBe(3);
      expect(state.newlineBeforeSemicolon).toBe(true);
    });
  });

  describe("storage failure reporting (issue #454)", () => {
    let spyWarn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.resetModules();
      spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      spyWarn.mockRestore();
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.clear();
      }
    });

    async function withFailingSetItem(err: DOMException, fn: () => void) {
      const original = window.localStorage.setItem;
      // jsdom keeps setItem as an own property; override the instance.
      // @ts-expect-error -- testing assignment to a host-provided method
      window.localStorage.setItem = () => {
        throw err;
      };
      try {
        fn();
      } finally {
        window.localStorage.setItem = original;
      }
    }

    it("reports a quota failure for query settings", async () => {
      const { useSettingsStore } = await import("../settingsStore");
      const { useStorageErrorStore } = await import("../storageErrorStore");

      await withFailingSetItem(new DOMException("quota", "QuotaExceededError"), () => {
        useSettingsStore.getState().setQuerySettings({
          maxResultRows: 999,
          limitEnabled: true,
        });
      });

      // In-memory write still succeeded.
      expect(useSettingsStore.getState().querySettings.maxResultRows).toBe(999);

      const message = useStorageErrorStore.getState().errors["query-settings"];
      expect(message).toMatch(/quota/i);
      expect(message).toMatch(/query settings/);
      expect(spyWarn).toHaveBeenCalled();
    });

    it("reports a blocked-storage failure for formatter settings", async () => {
      const { useSettingsStore } = await import("../settingsStore");
      const { useStorageErrorStore } = await import("../storageErrorStore");

      await withFailingSetItem(new DOMException("blocked", "SecurityError"), () => {
        useSettingsStore.getState().setFormatterSettings({
          ...defaultFormatterSettings,
          tabWidth: 4,
        });
      });

      expect(useStorageErrorStore.getState().errors["formatter-settings"]).toMatch(
        /private mode|cookies|blocked/i,
      );
    });

    it("clears the error on a later successful write", async () => {
      const { useSettingsStore } = await import("../settingsStore");
      const { useStorageErrorStore } = await import("../storageErrorStore");

      await withFailingSetItem(new DOMException("quota", "QuotaExceededError"), () => {
        useSettingsStore.getState().setQuerySettings({ maxResultRows: 1, limitEnabled: false });
      });
      expect(useStorageErrorStore.getState().errors["query-settings"]).toMatch(/quota/i);

      useSettingsStore.getState().setQuerySettings({ maxResultRows: 2, limitEnabled: false });
      expect(useStorageErrorStore.getState().errors["query-settings"]).toBeUndefined();
    });

    it("keeps the two settings errors independent (one key does not clear the other)", async () => {
      const { useSettingsStore } = await import("../settingsStore");
      const { useStorageErrorStore } = await import("../storageErrorStore");

      await withFailingSetItem(new DOMException("quota", "QuotaExceededError"), () => {
        useSettingsStore.getState().setFormatterSettings({
          ...defaultFormatterSettings,
          tabWidth: 4,
        });
      });
      expect(useStorageErrorStore.getState().errors["formatter-settings"]).toBeDefined();

      // A successful *query* settings write must not wipe the formatter error.
      useSettingsStore.getState().setQuerySettings({ maxResultRows: 5, limitEnabled: false });
      expect(useStorageErrorStore.getState().errors["formatter-settings"]).toBeDefined();
    });
  });

  describe("checkForUpdates", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("sets status to up-to-date when no update available", async () => {
      vi.resetModules();
      const updater = await import("@tauri-apps/plugin-updater");
      vi.mocked(updater.check).mockResolvedValue(null);
      const { useSettingsStore } = await import("../settingsStore");
      await useSettingsStore.getState().checkForUpdates();
      expect(useSettingsStore.getState().updateStatus).toBe("up-to-date");
      expect(useSettingsStore.getState().updateVersion).toBeNull();
    });

    it("sets status to available with version when update found", async () => {
      vi.resetModules();
      const updater = await import("@tauri-apps/plugin-updater");
      vi.mocked(updater.check).mockResolvedValue({ version: "1.0.0", downloadAndInstall: vi.fn() } as any);
      const { useSettingsStore } = await import("../settingsStore");
      await useSettingsStore.getState().checkForUpdates();
      expect(useSettingsStore.getState().updateStatus).toBe("available");
      expect(useSettingsStore.getState().updateVersion).toBe("1.0.0");
    });

    it("sets status to error when check throws", async () => {
      vi.resetModules();
      const updater = await import("@tauri-apps/plugin-updater");
      vi.mocked(updater.check).mockRejectedValue(new Error("network error"));
      const { useSettingsStore } = await import("../settingsStore");
      await useSettingsStore.getState().checkForUpdates();
      expect(useSettingsStore.getState().updateStatus).toBe("error");
    });

    it("on rpm-ostree, sets status to manual-update-required with copyable command", async () => {
      vi.resetModules();
      const updater = await import("@tauri-apps/plugin-updater");
      vi.mocked(updater.check).mockResolvedValue({ version: "0.4.1", downloadAndInstall: vi.fn() } as any);
      const { useSettingsStore } = await import("../settingsStore");
      useSettingsStore.setState({ packageFormat: "rpm_ostree", arch: "x86_64" });
      await useSettingsStore.getState().checkForUpdates();
      const state = useSettingsStore.getState();
      expect(state.updateStatus).toBe("manual-update-required");
      expect(state.updateVersion).toBe("0.4.1");
      expect(state.pendingUpdate).toBeNull();
      expect(state.manualUpdateCommand).toBe(
        "rpm-ostree install https://github.com/EVWorth/sqlpilot/releases/download/v0.4.1/SQLPilot-0.4.1-1.x86_64.rpm",
      );
    });

    it("on standard Linux/macOS/Windows, sets status to available (not manual)", async () => {
      vi.resetModules();
      const updater = await import("@tauri-apps/plugin-updater");
      const update = { version: "0.4.1", downloadAndInstall: vi.fn() } as any;
      vi.mocked(updater.check).mockResolvedValue(update);
      const { useSettingsStore } = await import("../settingsStore");
      useSettingsStore.setState({ packageFormat: "standard", arch: "x86_64" });
      await useSettingsStore.getState().checkForUpdates();
      const state = useSettingsStore.getState();
      expect(state.updateStatus).toBe("available");
      expect(state.manualUpdateCommand).toBeNull();
      expect(state.pendingUpdate).toBe(update);
    });

    it("treats platformHint=unknown as standard (best-effort: try the plugin path)", async () => {
      vi.resetModules();
      const updater = await import("@tauri-apps/plugin-updater");
      vi.mocked(updater.check).mockResolvedValue({ version: "0.4.1", downloadAndInstall: vi.fn() } as any);
      const { useSettingsStore } = await import("../settingsStore");
      // platformHint default is "unknown"
      await useSettingsStore.getState().checkForUpdates();
      expect(useSettingsStore.getState().updateStatus).toBe("available");
    });
  });

  describe("detectPlatform", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("records the package format when detection succeeds", async () => {
      vi.resetModules();
      const api = await import("../../lib/tauri-api");
      vi.mocked(api.api.getPlatformInfo).mockResolvedValue({ package_format: "rpm_ostree", arch: "aarch64" } as never);
      const { useSettingsStore } = await import("../settingsStore");
      await useSettingsStore.getState().detectPlatform();
      expect(useSettingsStore.getState().packageFormat).toBe("rpm_ostree");
    });

    it("records a standard install", async () => {
      vi.resetModules();
      const api = await import("../../lib/tauri-api");
      vi.mocked(api.api.getPlatformInfo).mockResolvedValue({ package_format: "standard", arch: "x86_64" } as never);
      const { useSettingsStore } = await import("../settingsStore");
      await useSettingsStore.getState().detectPlatform();
      expect(useSettingsStore.getState().packageFormat).toBe("standard");
    });

    it("leaves the format unknown when detection fails", async () => {
      vi.resetModules();
      const api = await import("../../lib/tauri-api");
      vi.mocked(api.api.getPlatformInfo).mockRejectedValue(new Error("boom"));
      const { useSettingsStore } = await import("../settingsStore");
      await useSettingsStore.getState().detectPlatform();
      expect(useSettingsStore.getState().packageFormat).toBeNull();
    });
  });

  describe("installUpdate", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("downloads and stages the update, but does not restart on its own", async () => {
      vi.resetModules();
      const process = await import("@tauri-apps/plugin-process");
      const downloadAndInstall = vi.fn();
      const { useSettingsStore } = await import("../settingsStore");
      const cached = { version: "1.0.0", downloadAndInstall } as any;
      useSettingsStore.setState({
        pendingUpdate: cached,
        updateStatus: "available",
        updateVersion: "1.0.0",
        downloadProgress: { transferred: 0, total: null },
      });
      await useSettingsStore.getState().installUpdate();
      expect(useSettingsStore.getState().updateStatus).toBe("downloaded");
      expect(downloadAndInstall).toHaveBeenCalledOnce();
      // Restarting closes the app, so it waits to be asked (#344).
      expect(process.relaunch).not.toHaveBeenCalled();

      await useSettingsStore.getState().restartToApply();
      expect(process.relaunch).toHaveBeenCalledOnce();
    });

    it("says so when the pending update has gone, rather than spinning", async () => {
      vi.resetModules();
      const process = await import("@tauri-apps/plugin-process");
      const { useSettingsStore } = await import("../settingsStore");
      useSettingsStore.setState({
        pendingUpdate: null,
        updateStatus: "available",
        updateVersion: null,
      });
      await useSettingsStore.getState().installUpdate();

      expect(process.relaunch).not.toHaveBeenCalled();
      // It used to set "downloading" and return, leaving the status bar
      // reporting a download that was not happening (#569).
      expect(useSettingsStore.getState().updateStatus).toBe("error");
      expect(useSettingsStore.getState().updateError).toContain("no longer available");
    });

    it("updates downloadProgress as bytes stream in via the onProgress callback", async () => {
      vi.resetModules();
      const process = await import("@tauri-apps/plugin-process");
      const events: unknown[] = [];
      const downloadAndInstall = vi.fn(
        (onProgress: (e: { event: string; data?: unknown }) => void) => {
          events.push({ event: "Started", data: { contentLength: 1000 } });
          onProgress({ event: "Started", data: { contentLength: 1000 } });
          events.push({ event: "Progress", data: { chunkLength: 250 } });
          onProgress({ event: "Progress", data: { chunkLength: 250 } });
          events.push({ event: "Progress", data: { chunkLength: 750 } });
          onProgress({ event: "Progress", data: { chunkLength: 750 } });
          return Promise.resolve();
        },
      );
      const { useSettingsStore } = await import("../settingsStore");
      useSettingsStore.setState({
        pendingUpdate: { version: "1.0.0", downloadAndInstall } as any,
        updateStatus: "available",
        updateVersion: "1.0.0",
        downloadProgress: { transferred: 0, total: null },
      });
      await useSettingsStore.getState().installUpdate();
      const final = useSettingsStore.getState().downloadProgress;
      expect(final).toEqual({ transferred: 1000, total: 1000 });
      // The download finishing is not the restart happening.
      expect(process.relaunch).not.toHaveBeenCalled();
    });

    it("surfaces the underlying error string in updateError", async () => {
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      const downloadAndInstall = vi.fn().mockRejectedValue(
        new Error("rpm install failed: signature verification failed"),
      );
      useSettingsStore.setState({
        pendingUpdate: { version: "1.0.0", downloadAndInstall } as any,
        updateStatus: "available",
        updateVersion: "1.0.0",
      });
      await useSettingsStore.getState().installUpdate();
      expect(useSettingsStore.getState().updateStatus).toBe("error");
      expect(useSettingsStore.getState().updateError).toBe(
        "rpm install failed: signature verification failed",
      );
    });

    it("refuses to restart while work would be lost, and says why", async () => {
      // The checks that authorised the download ran before it. A query
      // started or a tab edited since would otherwise be destroyed by a
      // restart nobody re-approved (#570).
      vi.resetModules();
      const process = await import("@tauri-apps/plugin-process");
      const { useResultStore } = await import("../resultStore");
      const { useSettingsStore } = await import("../settingsStore");

      useSettingsStore.setState({ updateStatus: "downloaded", updateVersion: "1.0.0" });
      useResultStore.setState({ isExecuting: true });

      await useSettingsStore.getState().restartToApply();

      expect(process.relaunch).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().updateStatus).toBe("error");
      expect(useSettingsStore.getState().updateError).toMatch(/query is still running/);

      useResultStore.setState({ isExecuting: false });
    });

    it("says the update is installed when the restart itself fails", async () => {
      // Telling the user to download again would be wrong: it is already on
      // disk, and quitting normally finishes the job.
      vi.resetModules();
      const process = await import("@tauri-apps/plugin-process");
      vi.mocked(process.relaunch).mockRejectedValueOnce(new Error("no permission"));
      const { useSettingsStore } = await import("../settingsStore");

      useSettingsStore.setState({ updateStatus: "downloaded", updateVersion: "1.0.0" });
      await useSettingsStore.getState().restartToApply();

      expect(useSettingsStore.getState().updateStatus).toBe("error");
      expect(useSettingsStore.getState().updateError).toMatch(/installed but the app could not restart/);
      expect(useSettingsStore.getState().updateError).toMatch(/Quit and reopen/);
    });

    it("refuses to start a download while work would be lost", async () => {
      vi.resetModules();
      const { useResultStore } = await import("../resultStore");
      const { useSettingsStore } = await import("../settingsStore");
      const downloadAndInstall = vi.fn();

      useSettingsStore.setState({
        pendingUpdate: { version: "1.0.0", downloadAndInstall } as never,
        updateStatus: "available",
      });
      useResultStore.setState({ isExecuting: true });

      await useSettingsStore.getState().installUpdate();

      expect(downloadAndInstall).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().updateStatus).toBe("error");

      useResultStore.setState({ isExecuting: false });
    });

    it("does not ask GitHub twice in quick succession", async () => {
      // The status bar re-runs the check whenever the status returns to idle,
      // which a store reset or a hot reload also does. Each one was a request
      // (#346).
      vi.resetModules();
      const updater = await import("@tauri-apps/plugin-updater");
      vi.mocked(updater.check).mockResolvedValue(null as never);
      const { useSettingsStore } = await import("../settingsStore");

      await useSettingsStore.getState().checkForUpdates();
      useSettingsStore.setState({ updateStatus: "idle" });
      await useSettingsStore.getState().checkForUpdates();
      useSettingsStore.setState({ updateStatus: "idle" });
      await useSettingsStore.getState().checkForUpdates();

      expect(updater.check).toHaveBeenCalledTimes(1);
    });

    it("still checks when the user asks, however recently one ran", async () => {
      vi.resetModules();
      const updater = await import("@tauri-apps/plugin-updater");
      vi.mocked(updater.check).mockResolvedValue(null as never);
      const { useSettingsStore } = await import("../settingsStore");

      await useSettingsStore.getState().checkForUpdates();
      await useSettingsStore.getState().checkForUpdates(true);

      expect(updater.check).toHaveBeenCalledTimes(2);
    });

    it("does not interrupt an install in flight", async () => {
      // A check landing mid-download would replace "downloading" with
      // "available" and take the progress display away from a download that
      // is still running (#347).
      vi.resetModules();
      const updater = await import("@tauri-apps/plugin-updater");
      vi.mocked(updater.check).mockResolvedValue({ version: "2.0.0" } as never);
      const { useSettingsStore } = await import("../settingsStore");

      for (const status of ["downloading", "downloaded"] as const) {
        useSettingsStore.setState({ updateStatus: status, updateVersion: "1.0.0" });
        await useSettingsStore.getState().checkForUpdates(true);
        expect(useSettingsStore.getState().updateStatus).toBe(status);
        expect(useSettingsStore.getState().updateVersion).toBe("1.0.0");
      }
      expect(updater.check).not.toHaveBeenCalled();
    });

    it("reports the version it actually installed", async () => {
      // The Update object is pinned when the download starts, so a check that
      // resolves during it cannot leave the UI naming a different one (#347).
      vi.resetModules();
      const { useSettingsStore } = await import("../settingsStore");
      useSettingsStore.setState({
        pendingUpdate: { version: "1.0.0", downloadAndInstall: vi.fn() } as never,
        updateStatus: "available",
        updateVersion: "9.9.9",
      });

      await useSettingsStore.getState().installUpdate();

      expect(useSettingsStore.getState().updateStatus).toBe("downloaded");
      expect(useSettingsStore.getState().updateVersion).toBe("1.0.0");
    });
  });
});
