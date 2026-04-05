import { useEffect } from "react";
import { useThemeStore } from "../stores/themeStore";
import { useMonaco } from "@monaco-editor/react";

export function useTheme() {
  const effectiveTheme = useThemeStore((s) => s.effectiveTheme);
  const monaco = useMonaco();

  useEffect(() => {
    if (monaco) {
      monaco.editor.setTheme(effectiveTheme === "dark" ? "vs-dark" : "vs");
    }
  }, [effectiveTheme, monaco]);
}
