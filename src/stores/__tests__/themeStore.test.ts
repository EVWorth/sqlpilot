import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useThemeStore } from "../themeStore";

describe("themeStore", () => {
  beforeEach(() => {
    localStorage.clear();
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
});
