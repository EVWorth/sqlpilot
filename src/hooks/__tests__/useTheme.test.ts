import { useMonaco } from "@monaco-editor/react";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtInTheme, type Theme } from "../../lib/themes";
import { useThemeStore } from "../../stores/themeStore";
import { useTheme } from "../useTheme";

vi.mock("@monaco-editor/react", () => ({ useMonaco: vi.fn() }));

const setTheme = vi.fn();
const defineTheme = vi.fn();
const monaco = { editor: { setTheme, defineTheme } };

const mockMonaco = (value: unknown) => (useMonaco as unknown as ReturnType<typeof vi.fn>).mockReturnValue(value);

/** The colours Monaco was told to use, by key. */
const definedColors = () => defineTheme.mock.calls.at(-1)?.[1].colors as Record<string, string>;

describe("useTheme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useThemeStore.setState({ theme: "dark", effectiveTheme: "dark", customThemes: [] });
  });

  it("builds a Monaco theme from the palette that is showing", () => {
    // Five themes rather than two makes the difference visible: a Nord window
    // with a generic dark editor in the middle of it reads as a bug (#350).
    useThemeStore.setState({ theme: "nord", effectiveTheme: "dark" });
    mockMonaco(monaco);

    renderHook(() => useTheme());

    expect(defineTheme).toHaveBeenCalled();
    expect(definedColors()["editor.background"]).toBe(builtInTheme("nord")!.colors["bg-primary"]);
    expect(setTheme).toHaveBeenCalledWith("sqlpilot");
  });

  it("bases the editor the same way round as the app", () => {
    useThemeStore.setState({ theme: "solarized-light", effectiveTheme: "light" });
    mockMonaco(monaco);

    renderHook(() => useTheme());

    expect(defineTheme.mock.calls.at(-1)?.[1].base).toBe("vs");
  });

  it("keeps Monaco's own syntax colours", () => {
    // The app's palette has nothing to say about how a SQL keyword should
    // differ from a string literal.
    useThemeStore.setState({ theme: "nord", effectiveTheme: "dark" });
    mockMonaco(monaco);

    renderHook(() => useTheme());

    expect(defineTheme.mock.calls.at(-1)?.[1].inherit).toBe(true);
    expect(defineTheme.mock.calls.at(-1)?.[1].rules).toEqual([]);
  });

  it("uses a custom theme's colours too", () => {
    const mine: Theme = {
      ...builtInTheme("dark")!,
      id: "mine",
      name: "Mine",
      builtIn: false,
      colors: { ...builtInTheme("dark")!.colors, "bg-primary": "#123456" },
    };
    useThemeStore.setState({ theme: "mine", effectiveTheme: "dark", customThemes: [mine] });
    mockMonaco(monaco);

    renderHook(() => useTheme());

    expect(definedColors()["editor.background"]).toBe("#123456");
  });

  it.each([
    ["system following a dark OS", "dark", "vs-dark"],
    ["system following a light OS", "light", "vs"],
  ])("falls back to Monaco's own theme for %s", (_name, effective, expected) => {
    // "system" is a rule for picking a theme, not a palette of its own.
    useThemeStore.setState({ theme: "system", effectiveTheme: effective as "dark" | "light" });
    mockMonaco(monaco);

    renderHook(() => useTheme());

    expect(setTheme).toHaveBeenCalledWith(expected);
    expect(defineTheme).not.toHaveBeenCalled();
  });

  it("falls back for an id that names nothing", () => {
    useThemeStore.setState({ theme: "went-away", effectiveTheme: "dark" });
    mockMonaco(monaco);

    renderHook(() => useTheme());

    expect(setTheme).toHaveBeenCalledWith("vs-dark");
  });

  it.each([[null], [undefined]])("does not crash when Monaco is %s", (value) => {
    mockMonaco(value);
    expect(() => renderHook(() => useTheme())).not.toThrow();
    expect(setTheme).not.toHaveBeenCalled();
  });

  it("applies the theme when Monaco mounts after the change", () => {
    // Monaco loads asynchronously, so a theme chosen before it mounts has
    // nowhere to go at the time it is chosen (#351).
    useThemeStore.setState({ theme: "nord", effectiveTheme: "dark" });
    let current: unknown = null;
    (useMonaco as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => current);

    const { rerender } = renderHook(() => useTheme());
    expect(setTheme).not.toHaveBeenCalled();

    current = monaco;
    rerender();

    expect(setTheme).toHaveBeenCalledWith("sqlpilot");
  });

  it("re-applies when the theme changes", () => {
    mockMonaco(monaco);
    const { rerender } = renderHook(() => useTheme());

    useThemeStore.setState({ theme: "nord", effectiveTheme: "dark" });
    rerender();

    expect(definedColors()["editor.background"]).toBe(builtInTheme("nord")!.colors["bg-primary"]);
  });
});
