import type { editor } from "monaco-editor";
import { isColor, slug, type Theme } from "./themes";

/** The name a theme is registered under with Monaco. */
export function monacoThemeName(theme: Theme): string {
  return `sqlpilot-${slug(theme.id)}`;
}

/** `#rgb` to `#rrggbb`, since Monaco reads only the long forms. */
function longHex(color: string): string {
  const c = color.trim();
  return c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c;
}

/**
 * The editor's colours from the app theme (#838).
 *
 * The editor picked `vs-dark` or `vs` by the theme's base alone, so with Nord
 * it stayed vs-dark grey and with Solarized Light it was plain white while
 * everything around it followed the palette. Syntax colours still come from
 * the base theme (`inherit`); the surfaces come from the app's tokens.
 */
export function monacoThemeData(theme: Theme): editor.IStandaloneThemeData {
  const c = theme.colors;
  const pairs: [string, string | undefined][] = [
    ["editor.background", c["bg-primary"]],
    ["editor.foreground", c["text-primary"]],
    ["editor.lineHighlightBackground", c["bg-secondary"]],
    ["editor.lineHighlightBorder", c["bg-secondary"]],
    // A wash of the brand colour, so the selection reads on any background.
    ["editor.selectionBackground", isColor(c["brand-500"]) ? `${longHex(c["brand-500"]).slice(0, 7)}55` : undefined],
    [
      "editor.inactiveSelectionBackground",
      isColor(c["brand-500"]) ? `${longHex(c["brand-500"]).slice(0, 7)}30` : undefined,
    ],
    ["editorCursor.foreground", c["brand-400"]],
    ["editorLineNumber.foreground", c["text-muted"]],
    ["editorLineNumber.activeForeground", c["text-secondary"]],
    ["editorGutter.background", c["bg-primary"]],
    ["editorWidget.background", c["bg-secondary"]],
    ["editorWidget.border", c["border"]],
    ["editorSuggestWidget.background", c["bg-secondary"]],
    ["editorSuggestWidget.border", c["border"]],
    ["editorIndentGuide.background1", c["border"]],
  ];
  const colors: Record<string, string> = {};
  for (const [key, value] of pairs) {
    if (value && isColor(value)) colors[key] = longHex(value);
  }
  return { base: theme.base === "dark" ? "vs-dark" : "vs", inherit: true, rules: [], colors };
}
