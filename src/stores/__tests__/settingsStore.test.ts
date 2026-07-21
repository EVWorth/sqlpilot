import { beforeEach, describe, expect, it, vi } from "vitest";

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
