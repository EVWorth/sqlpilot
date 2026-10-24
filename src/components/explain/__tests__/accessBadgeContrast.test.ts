import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES, contrastRatio, MIN_TEXT_CONTRAST } from "../../../lib/themes";
import { ACCESS_TYPES, TONE_CLASS, TONE_TEXT_SHARE } from "../ExplainPanel";

// #849: white text on pale tints left ALL and friends unreadable in the light
// theme. Each badge's text is now its status colour mixed toward the theme's
// text colour, on a 12% wash of the status colour (what `surface-*` mixes).
// This checks that pairing in every built-in theme over both backgrounds the
// badges sit on.

/** `color-mix(in srgb, fg pct%, bg)` for opaque hex colours. */
function mix(fg: string, pct: number, bg: string): string {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [rgb(fg), rgb(bg)];
  return "#" + a.map((v, i) => Math.round(v * pct + b[i] * (1 - pct)).toString(16).padStart(2, "0")).join("");
}

describe("Explain access-type badges (#849)", () => {
  it("pair each tone's text colour with its own surface", () => {
    for (const { tone } of ACCESS_TYPES) {
      const pct = Math.round(TONE_TEXT_SHARE * 100);
      expect(TONE_CLASS[tone]).toBe(
        `surface-${tone} text-[color-mix(in_srgb,var(--color-${tone})_${pct}%,var(--color-text-primary))]`,
      );
    }
  });

  for (const theme of BUILT_IN_THEMES) {
    for (const ground of ["bg-primary", "bg-secondary"] as const) {
      it(`read at AA in the ${theme.id} theme on ${ground}`, () => {
        const tones = new Set(ACCESS_TYPES.map((a) => a.tone));
        for (const tone of tones) {
          const fg = mix(theme.colors[tone], TONE_TEXT_SHARE, theme.colors["text-primary"]);
          const bg = mix(theme.colors[tone], 0.12, theme.colors[ground]);
          expect(contrastRatio(fg, bg), `${tone}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        }
      });
    }
  }
});
