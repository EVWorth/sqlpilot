import { useMonaco } from "@monaco-editor/react";
import { useEffect } from "react";
import { allThemes, useThemeStore } from "../stores/themeStore";

/**
 * Keeping the editor in the same theme as the app around it.
 *
 * Monaco has its own theme registry, so this defines one from whatever
 * palette is showing rather than picking between `vs` and `vs-dark`. With
 * five themes rather than two, the difference is visible: a Nord window with
 * a generic dark editor in the middle of it reads as a bug (#350).
 *
 * `inherit: true` keeps Monaco's own syntax colours — they are tuned per
 * token type, and the app's eleven-colour palette has nothing to say about
 * how a SQL keyword should differ from a string literal.
 */

const THEME_NAME = "sqlpilot";

export function useTheme() {
  const theme = useThemeStore((s) => s.theme);
  const effectiveTheme = useThemeStore((s) => s.effectiveTheme);
  const customThemes = useThemeStore((s) => s.customThemes);

  const monaco = useMonaco();

  useEffect(() => {
    // Monaco loads asynchronously, so this runs again when it arrives — the
    // dependency is what makes a theme chosen before it mounts still apply
    // (#351).
    if (!monaco) return;

    const active = allThemes(customThemes).find((t) => t.id === theme);
    if (!active) {
      // "system", or an id that names nothing. Nothing to build a palette
      // from, so use Monaco's own.
      monaco.editor.setTheme(effectiveTheme === "dark" ? "vs-dark" : "vs");
      return;
    }

    monaco.editor.defineTheme(THEME_NAME, {
      base: active.base === "dark" ? "vs-dark" : "vs",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": active.colors["bg-primary"],
        "editor.foreground": active.colors["text-primary"],
        "editorLineNumber.foreground": active.colors["text-muted"],
        "editorGutter.background": active.colors["bg-primary"],
        "editorWidget.background": active.colors["bg-secondary"],
        "editorWidget.border": active.colors.border,
        "editor.lineHighlightBackground": active.colors["bg-secondary"],
        "editor.selectionBackground": active.colors["brand-700"],
        "editorCursor.foreground": active.colors.accent,
      },
    });
    monaco.editor.setTheme(THEME_NAME);
  }, [monaco, theme, effectiveTheme, customThemes]);
}
