import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    // restore, not clear: `clearAllMocks` leaves a spy's implementation in
    // place, so the test that makes localStorage.getItem throw was still
    // throwing in every test that followed it.
    vi.restoreAllMocks();
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

  it("reports a failed theme persist instead of swallowing it (refs #348)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { useStorageErrorStore } = await import("../storageErrorStore");
    useStorageErrorStore.setState({ errors: {} });

    const original = window.localStorage.setItem;
    // @ts-expect-error -- testing assignment to a host-provided method
    window.localStorage.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    try {
      useThemeStore.getState().setTheme("light");
    } finally {
      window.localStorage.setItem = original;
    }

    // The theme still applied in-memory...
    expect(useThemeStore.getState().theme).toBe("light");
    // ...but the failure is now visible rather than silent.
    expect(useStorageErrorStore.getState().errors.theme).toMatch(/quota/i);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("clears a prior theme storage error once a write succeeds (refs #348)", async () => {
    const { useStorageErrorStore } = await import("../storageErrorStore");
    useStorageErrorStore.setState({ errors: { theme: "stale" } });

    useThemeStore.getState().setTheme("light");

    expect(useStorageErrorStore.getState().errors.theme).toBeUndefined();
  });

  it("cycleTheme steps dark → light → system → dark (refs #453)", () => {
    const cycle = () => useThemeStore.getState().cycleTheme();

    cycle();
    expect(useThemeStore.getState().theme).toBe("light");
    cycle();
    expect(useThemeStore.getState().theme).toBe("system");
    cycle();
    expect(useThemeStore.getState().theme).toBe("dark");
  });

  it("cycleTheme persists and applies like setTheme does", () => {
    useThemeStore.getState().cycleTheme();
    expect(localStorage.getItem("theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
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

    vi.spyOn(window, "matchMedia").mockImplementation((query) =>
      ({
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
      }) as unknown as MediaQueryList
    );

    vi.resetModules();
    const mod = await import("../themeStore");

    // listener kuruldu mu?
    expect(registeredHandler).not.toBeNull();

    // temizlik, aynı handler ile removeEventListener çağırmalı
    mod.cleanupThemeListener();
    expect(removeEventListener).toHaveBeenCalledWith("change", registeredHandler);
  });
});

describe("themeStore custom themes (#350)", () => {
  let store: typeof import("../themeStore").useThemeStore;
  let allThemes: typeof import("../themeStore").allThemes;
  let serializeTheme: typeof import("../../lib/themes").serializeTheme;
  let builtInTheme: typeof import("../../lib/themes").builtInTheme;

  const mine = () => ({
    id: "mine",
    name: "Mine",
    base: "dark" as const,
    colors: { ...builtInTheme("dark")!.colors, "bg-primary": "#123456" },
  });

  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    const themes = await import("../../lib/themes");
    serializeTheme = themes.serializeTheme;
    builtInTheme = themes.builtInTheme;
    const mod = await import("../themeStore");
    store = mod.useThemeStore;
    allThemes = mod.allThemes;
  });

  const varOf = (token: string) => document.documentElement.style.getPropertyValue(`--color-${token}`);

  it("ships more than two themes", () => {
    // NFR-5.2's floor. Two hardcoded in a stylesheet was the whole system.
    expect(allThemes([]).length).toBeGreaterThanOrEqual(3);
  });

  it("writes a chosen theme's colours onto the document", () => {
    store.getState().setTheme("nord");

    expect(varOf("bg-primary")).toBe("#2e3440");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(store.getState().effectiveTheme).toBe("dark");
  });

  it("reports a light theme as light, so Monaco and the scrollbars follow", () => {
    store.getState().setTheme("solarized-light");
    expect(store.getState().effectiveTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("saves a custom theme and offers it", () => {
    store.getState().saveCustomTheme(mine());

    expect(store.getState().customThemes.map((t) => t.id)).toEqual(["mine"]);
    expect(allThemes(store.getState().customThemes).some((t) => t.id === "mine")).toBe(true);
  });

  it("replaces a custom theme rather than duplicating it", () => {
    store.getState().saveCustomTheme(mine());
    store.getState().saveCustomTheme({ ...mine(), name: "Renamed" });

    expect(store.getState().customThemes).toHaveLength(1);
    expect(store.getState().customThemes[0].name).toBe("Renamed");
  });

  it("applies an edit to the theme currently showing", () => {
    store.getState().saveCustomTheme(mine());
    store.getState().setTheme("mine");

    store.getState().saveCustomTheme({
      ...mine(),
      colors: { ...mine().colors, "bg-primary": "#abcdef" },
    });

    expect(varOf("bg-primary")).toBe("#abcdef");
  });

  it("survives a restart", async () => {
    store.getState().saveCustomTheme(mine());
    store.getState().setTheme("mine");

    vi.resetModules();
    const reloaded = await import("../themeStore");

    expect(reloaded.useThemeStore.getState().theme).toBe("mine");
    expect(reloaded.useThemeStore.getState().customThemes.map((t) => t.id)).toEqual(["mine"]);
  });

  describe("deleting", () => {
    it("removes it", () => {
      store.getState().saveCustomTheme(mine());
      store.getState().deleteCustomTheme("mine");
      expect(store.getState().customThemes).toEqual([]);
    });

    it("falls back when the deleted theme was the one showing", () => {
      // Otherwise it stays on screen with nothing behind it.
      store.getState().saveCustomTheme(mine());
      store.getState().setTheme("mine");

      store.getState().deleteCustomTheme("mine");

      expect(store.getState().theme).toBe("dark");
      expect(varOf("bg-primary")).toBe(builtInTheme("dark")!.colors["bg-primary"]);
    });
  });

  describe("importing", () => {
    it("takes a theme file and selects nothing by itself", () => {
      const error = store.getState().importTheme(serializeTheme(mine()));

      expect(error).toBeNull();
      expect(store.getState().customThemes[0].name).toBe("Mine");
    });

    it("reports why a bad file was refused", () => {
      expect(store.getState().importTheme("not json")).toContain("JSON");
      expect(store.getState().customThemes).toEqual([]);
    });

    it("refuses a value that is not a colour", () => {
      // The one place a stranger's data reaches the stylesheet.
      const hostile = JSON.stringify({
        name: "Hostile",
        base: "dark",
        colors: { ...mine().colors, "bg-primary": "url(https://example.com/x)" },
      });

      expect(store.getState().importTheme(hostile)).toContain("bg-primary");
      expect(store.getState().customThemes).toEqual([]);
    });

    it("does not let an import shadow a built-in", () => {
      // Taking the id `dark` would make the original unreachable.
      store.getState().importTheme(
        JSON.stringify({ name: "Dark", id: "dark", base: "dark", colors: mine().colors }),
      );

      expect(store.getState().customThemes[0].id).toBe("dark-custom");
      expect(builtInTheme("dark")!.name).toBe("Dark");
    });
  });

  describe("preview", () => {
    it("shows a theme without recording it", () => {
      // Every keystroke in the editor is a new palette, and none of them
      // should be what the app reopens as.
      store.getState().setTheme("dark");

      store.getState().preview({ ...mine(), colors: { ...mine().colors, "bg-primary": "#ff0000" } });

      expect(varOf("bg-primary")).toBe("#ff0000");
      expect(store.getState().theme).toBe("dark");
      expect(localStorage.getItem("theme")).toBe("dark");
    });

    it("puts back the chosen theme when the preview ends", () => {
      store.getState().setTheme("nord");
      store.getState().preview({ ...mine(), colors: { ...mine().colors, "bg-primary": "#ff0000" } });

      store.getState().preview(null);

      expect(varOf("bg-primary")).toBe("#2e3440");
    });
  });

  it("falls back to dark for an id that names nothing", () => {
    // A theme from a newer version, or one deleted outside the app.
    localStorage.setItem("theme", "a-theme-that-went-away");
    vi.resetModules();

    return import("../themeStore").then((reloaded) => {
      expect(reloaded.useThemeStore.getState().effectiveTheme).toBe("dark");
      expect(varOf("bg-primary")).toBe(builtInTheme("dark")!.colors["bg-primary"]);
    });
  });

  it("ignores junk in the stored custom themes rather than failing to start", () => {
    localStorage.setItem("sqlpilot.custom-themes", "[{\"name\":\"bad\"},\"nonsense\",42]");
    vi.resetModules();

    return import("../themeStore").then((reloaded) => {
      expect(reloaded.useThemeStore.getState().customThemes).toEqual([]);
    });
  });

  it("keeps the toggle to the three original modes", () => {
    // A cycle that stepped through every imported theme would take as many
    // clicks as the user has themes, which is not a toggle.
    store.getState().saveCustomTheme(mine());
    store.getState().setTheme("dark");

    store.getState().cycleTheme();
    expect(store.getState().theme).toBe("light");
    store.getState().cycleTheme();
    expect(store.getState().theme).toBe("system");
    store.getState().cycleTheme();
    expect(store.getState().theme).toBe("dark");
  });
});
