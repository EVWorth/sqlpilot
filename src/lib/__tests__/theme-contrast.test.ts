import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES, contrastRatio, MIN_TEXT_CONTRAST, type Theme, type ThemeToken } from "../themes";

/**
 * Every theme we author has to be readable; every theme we quote has to stay
 * faithful.
 *
 * This is arithmetic over values that already live in the repo, so there is no
 * reason for it to have been a manual check — and it was never done. The
 * default light theme put the menu bar, the status bar and every empty state
 * at around 2.4:1.
 *
 * The bar is 4.5:1 rather than the 3:1 allowed for large text, because nothing
 * in this app is large: the type scale runs 10px to 14px, and 18.66px is where
 * the concession starts.
 *
 * Nord and Solarized are exempt from that bar and held to a different one.
 * They reproduce published palettes, neither of which can reach AA and remain
 * itself, so correcting their values would produce a theme wearing a name that
 * no longer describes it. What is asserted instead is that they still match
 * the palette they claim to be — the failure mode for a quoted theme is drift,
 * not contrast. Their real ratios are printed rather than asserted, so the
 * cost stays visible.
 */

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

const round = (n: number) => Math.round(n * 100) / 100;

const AUTHORED = BUILT_IN_THEMES.filter((t) => t.origin !== "quoted");
const QUOTED = BUILT_IN_THEMES.filter((t) => t.origin === "quoted");

/** The published palettes, as their authors define them. */
const CANONICAL: Record<string, Partial<Record<ThemeToken, string>>> = {
  // nordtheme.com — Polar Night, Snow Storm, Frost, Aurora.
  nord: {
    "bg-primary": "#2e3440",
    "bg-secondary": "#3b4252",
    "bg-tertiary": "#434c5e",
    "border": "#4c566a",
    "text-primary": "#eceff4",
    "text-secondary": "#d8dee9",
    "text-muted": "#8fbcbb",
    "accent": "#88c0d0",
    "success": "#a3be8c",
    "warning": "#ebcb8b",
    "error": "#bf616a",
    "brand-500": "#81a1c1",
    "brand-600": "#5e81ac",
  },
  // ethanschoonover.com/solarized — base tones plus the accent ring.
  "solarized-light": {
    "bg-primary": "#fdf6e3",
    "bg-secondary": "#eee8d5",
    "text-primary": "#073642",
    "text-secondary": "#586e75",
    "text-muted": "#93a1a1",
    "accent": "#268bd2",
    "success": "#859900",
    "warning": "#b58900",
    "error": "#dc322f",
  },
};

describe.each(AUTHORED.map((theme) => [theme.id, theme] as const))(
  "%s theme (authored)",
  (_id, theme: Theme) => {
    it.each(
      FOREGROUNDS.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)),
    )("%s on %s clears AA", (fg, bg) => {
      const ratio = contrastRatio(theme.colors[fg], theme.colors[bg]);
      expect(
        round(ratio),
        `${theme.colors[fg]} on ${theme.colors[bg]} is ${round(ratio)}:1, needs ${MIN_TEXT_CONTRAST}`,
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });

    it("can fill a button with white text on it", () => {
      // Primary actions are white on a brand fill. Some rung of the ramp has
      // to be dark enough to carry that, or every primary button in the theme
      // fails — which is what "Run" was doing at 3.22:1.
      const ratio = contrastRatio("#ffffff", theme.colors["brand-600"]);
      expect(
        round(ratio),
        `white on brand-600 ${theme.colors["brand-600"]} is ${round(ratio)}:1`,
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });
  },
);

describe.each(QUOTED.map((theme) => [theme.id, theme] as const))(
  "%s theme (quoted)",
  (id, theme: Theme) => {
    it.each(Object.entries(CANONICAL[id]))(
      "%s still matches the published palette",
      (token, published) => {
        // A quoted theme's job is to be the thing it is named after. Drifting
        // one value — including drifting it to something more readable — makes
        // the name wrong, so that is what this catches.
        expect(theme.colors[token as ThemeToken]).toBe(published);
      },
    );

    it("is declared as quoted, so nothing holds it to AA by accident", () => {
      expect(theme.origin).toBe("quoted");
    });

    it("reports what its palette costs in contrast", () => {
      // Printed, not asserted. These palettes were not designed against WCAG
      // and cannot pass while staying themselves; the number is here so the
      // trade stays visible to whoever reads this file next.
      const worst = FOREGROUNDS.flatMap((fg) =>
        SURFACES.map((bg) => ({
          pair: `${fg} on ${bg}`,
          ratio: round(contrastRatio(theme.colors[fg], theme.colors[bg])),
        }))
      ).sort((a, b) => a.ratio - b.ratio)[0];
      expect(worst.ratio).toBeGreaterThan(1);
      console.info(`  ${id}: worst pair is ${worst.pair} at ${worst.ratio}:1`);
    });
  },
);

describe("every built-in theme", () => {
  it.each(BUILT_IN_THEMES.map((t) => [t.id, t] as const))(
    "%s declares a base matching how light its surfaces are",
    (_id, theme: Theme) => {
      // A theme whose `base` disagrees with its own colours sends the wrong
      // `color-scheme` to the platform, so native scrollbars and form controls
      // come back in the opposite theme to the app around them.
      // Against white: a light surface is close to it, a dark one is not.
      const light = contrastRatio(theme.colors["bg-primary"], "#ffffff") < 2;
      expect(light ? "light" : "dark").toBe(theme.base);
    },
  );
});

describe("contrast", () => {
  it("is symmetric and matches known values", () => {
    // Guards the maths itself: black on white is exactly 21:1 by definition,
    // and swapping the arguments cannot change a ratio.
    expect(round(contrastRatio("#000000", "#ffffff"))).toBe(21);
    expect(round(contrastRatio("#ffffff", "#000000"))).toBe(21);
    expect(round(contrastRatio("#ffffff", "#ffffff"))).toBe(1);
  });
});
