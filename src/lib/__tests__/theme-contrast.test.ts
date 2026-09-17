import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES, type Theme, type ThemeToken } from "../themes";

/**
 * Every built-in theme has to be readable.
 *
 * This is arithmetic over values that already live in the repo, so there is no
 * reason for it to have been a manual check — and it was never done. Four of
 * the five built-in themes shipped with text below the WCAG AA floor; the
 * worst of them failed 17 of its 21 pairs, and the default light theme put the
 * menu bar, the status bar and every empty state at around 2.4:1.
 *
 * The bar is 4.5:1 rather than the 3:1 allowed for large text, because nothing
 * in this app is large: the type scale runs 10px to 14px, and 18.66px is where
 * the concession starts.
 */

/** WCAG 2.1 SC 1.4.3, normal text. */
const AA_TEXT = 4.5;

/** Colours that carry text. */
const FOREGROUNDS: ThemeToken[] = [
  "text-primary",
  "text-secondary",
  "text-muted",
  "accent",
  "success",
  "warning",
  "error",
];

/** Colours text sits on. */
const SURFACES: ThemeToken[] = ["bg-primary", "bg-secondary", "bg-tertiary"];

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const at = (i: number) => parseInt(value.slice(i, i + 2), 16);
  return [at(0), at(2), at(4)];
}

/** Relative luminance, WCAG 2.1 definition. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((raw) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const round = (n: number) => Math.round(n * 100) / 100;

describe.each(BUILT_IN_THEMES.map((theme) => [theme.id, theme] as const))(
  "%s theme",
  (_id, theme: Theme) => {
    it.each(
      FOREGROUNDS.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)),
    )("%s on %s clears AA", (fg, bg) => {
      const ratio = contrast(theme.colors[fg], theme.colors[bg]);
      expect(
        round(ratio),
        `${theme.colors[fg]} on ${theme.colors[bg]} is ${round(ratio)}:1, needs ${AA_TEXT}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it("can fill a button with white text on it", () => {
      // Primary actions are white on a brand fill. Some rung of the ramp has
      // to be dark enough to carry that, or every primary button in the theme
      // fails — which is what "Run" was doing at 3.22:1.
      const ratio = contrast("#ffffff", theme.colors["brand-600"]);
      expect(
        round(ratio),
        `white on brand-600 ${theme.colors["brand-600"]} is ${round(ratio)}:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it("declares a base that matches how light its surfaces are", () => {
      // A theme whose `base` disagrees with its own colours sends the wrong
      // `color-scheme` to the platform, so native scrollbars and form controls
      // come back in the opposite theme to the app around them.
      const light = luminance(theme.colors["bg-primary"]) > 0.5;
      expect(light ? "light" : "dark").toBe(theme.base);
    });
  },
);

describe("contrast", () => {
  it("is symmetric and matches known values", () => {
    // Guards the maths itself: black on white is exactly 21:1 by definition,
    // and swapping the arguments cannot change a ratio.
    expect(round(contrast("#000000", "#ffffff"))).toBe(21);
    expect(round(contrast("#ffffff", "#000000"))).toBe(21);
    expect(round(contrast("#ffffff", "#ffffff"))).toBe(1);
  });
});
