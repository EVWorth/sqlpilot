import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

describe("themeStore", () => {
  let useThemeStore: typeof import("../themeStore").useThemeStore;

  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    const mod = await import("../themeStore");
    useThemeStore = mod.useThemeStore;
    useThemeStore.setState({ theme: "dark", effectiveTheme: "dark" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sets theme to light", () => {
    useThemeStore.getState().setTheme("light");
    const state = useThemeStore.getState();
    expect(state.theme).toBe("light");
    expect(state.effectiveTheme).toBe("light");
  });

  it("sets theme to dark", () => {
    useThemeStore.getState().setTheme("dark");
    const state = useThemeStore.getState();
    expect(state.theme).toBe("dark");
    expect(state.effectiveTheme).toBe("dark");
  });

  it("persists theme to localStorage", () => {
    useThemeStore.getState().setTheme("light");
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("sets data-theme attribute on html element", () => {
    useThemeStore.getState().setTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("resolves system theme from matchMedia", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    useThemeStore.getState().setTheme("system");
    const state = useThemeStore.getState();
    expect(state.theme).toBe("system");
    expect(state.effectiveTheme).toBe("dark");
  });

  it("system theme listener responds to matchMedia changes", async () => {
    let changeHandler: (() => void) | null = null;

    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_event: string, handler: () => void) => {
        changeHandler = handler;
      },
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    vi.resetModules();
    const mod = await import("../themeStore");
    const freshStore = mod.useThemeStore;

    freshStore.getState().setTheme("system");
    expect(freshStore.getState().theme).toBe("system");
    expect(freshStore.getState().effectiveTheme).toBe("dark");

    expect(changeHandler).not.toBeNull();
    changeHandler!();
    expect(freshStore.getState().effectiveTheme).toBe("dark");
  });

  it("system theme listener does nothing when not in system mode", async () => {
    let changeHandler: (() => void) | null = null;

    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_event: string, handler: () => void) => {
        changeHandler = handler;
      },
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    vi.resetModules();
    const mod = await import("../themeStore");
    const freshStore = mod.useThemeStore;

    freshStore.getState().setTheme("light");
    expect(freshStore.getState().effectiveTheme).toBe("light");

    changeHandler!();
    expect(freshStore.getState().effectiveTheme).toBe("light");
  });

  it("reads light theme from localStorage on init", async () => {
    localStorage.setItem("theme", "light");
    vi.resetModules();
    const mod = await import("../themeStore");
    expect(mod.useThemeStore.getState().theme).toBe("light");
    expect(mod.useThemeStore.getState().effectiveTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to dark when localStorage.getItem throws", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    vi.resetModules();
    const mod = await import("../themeStore");
    expect(mod.useThemeStore.getState().theme).toBe("dark");
    expect(mod.useThemeStore.getState().effectiveTheme).toBe("dark");
  });

  it("handles localStorage.setItem throwing gracefully", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    vi.resetModules();
    const mod = await import("../themeStore");
    expect(() => mod.useThemeStore.getState().setTheme("light")).not.toThrow();
    expect(mod.useThemeStore.getState().theme).toBe("light");
});

it("cleanupThemeListener removes the matchMedia change listener", async () => {
    const removeEventListener = vi.fn();
    let registeredHandler: (() => void) | null = null;

    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_event: string, handler: () => void) => {
        registeredHandler = handler;
      },
      removeEventListener,
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList);

    vi.resetModules();
    const mod = await import("../themeStore");

    // listener kuruldu mu?
    expect(registeredHandler).not.toBeNull();

    // temizlik, aynı handler ile removeEventListener çağırmalı
    mod.cleanupThemeListener();
    expect(removeEventListener).toHaveBeenCalledWith("change", registeredHandler);
  });
});
