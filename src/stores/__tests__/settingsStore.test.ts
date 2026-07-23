import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/tauri-api", () => ({
  api: {
    isRpmOstree: vi.fn().mockResolvedValue(false),
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
      useSettingsStore.setState({ platformHint: "rpm-ostree" });
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
      useSettingsStore.setState({ platformHint: "standard" });
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

    it("sets platformHint to rpm-ostree when api reports true", async () => {
      vi.resetModules();
      const api = await import("../../lib/tauri-api");
      vi.mocked(api.api.isRpmOstree).mockResolvedValue(true);
      const { useSettingsStore } = await import("../settingsStore");
      await useSettingsStore.getState().detectPlatform();
      expect(useSettingsStore.getState().platformHint).toBe("rpm-ostree");
    });

    it("sets platformHint to standard when api reports false", async () => {
      vi.resetModules();
      const api = await import("../../lib/tauri-api");
      vi.mocked(api.api.isRpmOstree).mockResolvedValue(false);
      const { useSettingsStore } = await import("../settingsStore");
      await useSettingsStore.getState().detectPlatform();
      expect(useSettingsStore.getState().platformHint).toBe("standard");
    });

    it("sets platformHint to unknown when api throws", async () => {
      vi.resetModules();
      const api = await import("../../lib/tauri-api");
      vi.mocked(api.api.isRpmOstree).mockRejectedValue(new Error("boom"));
      const { useSettingsStore } = await import("../settingsStore");
      await useSettingsStore.getState().detectPlatform();
      expect(useSettingsStore.getState().platformHint).toBe("unknown");
    });
  });

  describe("installUpdate", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("downloads, installs, and relaunches using the cached Update", async () => {
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
      expect(process.relaunch).toHaveBeenCalledOnce();
    });

    it("does nothing when no cached update is available", async () => {
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
      expect(process.relaunch).toHaveBeenCalledOnce();
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
  });
});
