import { describe, expect, it } from "vitest";
import { monacoThemeData, monacoThemeName } from "../monaco-theme";
import { builtInTheme } from "../themes";

describe("monaco-theme (#838)", () => {
  it("takes the editor's surfaces from a built-in theme", () => {
    const nord = builtInTheme("nord");
    expect(nord).toBeDefined();
    if (!nord) return;
    const data = monacoThemeData(nord);
    expect(data.base).toBe("vs-dark");
    expect(data.inherit).toBe(true);
    expect(data.colors["editor.background"]).toBe(nord.colors["bg-primary"]);
    expect(data.colors["editor.foreground"]).toBe(nord.colors["text-primary"]);
    expect(data.colors["editor.lineHighlightBackground"]).toBe(nord.colors["bg-secondary"]);
    expect(data.colors["editor.selectionBackground"]).toMatch(/^#[0-9a-f]{6}55$/i);
  });

  it("uses the light base for a light theme", () => {
    const solarized = builtInTheme("solarized-light");
    expect(solarized && monacoThemeData(solarized).base).toBe("vs");
  });

  it("expands short hex and drops anything that is not a colour", () => {
    const dark = builtInTheme("dark");
    if (!dark) throw new Error("no dark theme");
    const data = monacoThemeData({
      ...dark,
      colors: { ...dark.colors, "bg-primary": "#123", "text-primary": "red" },
    });
    expect(data.colors["editor.background"]).toBe("#112233");
    expect(data.colors["editor.foreground"]).toBeUndefined();
  });

  it("names each theme apart", () => {
    const nord = builtInTheme("nord");
    const dark = builtInTheme("dark");
    if (!nord || !dark) throw new Error("missing built-ins");
    expect(monacoThemeName(nord)).not.toBe(monacoThemeName(dark));
  });
});
