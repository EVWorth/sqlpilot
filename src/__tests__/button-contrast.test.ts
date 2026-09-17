import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * White text on a coloured fill has to be readable, in every state.
 *
 * The theme tokens are covered by `lib/__tests__/theme-contrast.test.ts`. This
 * covers the other half: buttons painted with a palette class rather than a
 * token, which the token test cannot see.
 *
 * Thirty-five combinations were below the floor when this was written, and
 * almost all of them were the *hover* state rather than the resting one. A
 * button would sit at a perfectly legible `bg-brand-600` and then, on hover,
 * lighten to `bg-brand-500` and fall to 3.68:1 — legible until you reached for
 * it. WCAG applies to every state, and hover is the state a person is in at
 * the moment they are reading the label to decide whether to click.
 *
 * The trap worth knowing: the rung that carries white text is not the same
 * across hues. Red and blue manage it at 600; green, amber and yellow do not
 * until 700, because a saturated mid-green is far lighter than a mid-red at
 * the same number. `bg-green-600` reads as the safe choice and is not one.
 */

/**
 * sRGB for the palette rungs this app paints with.
 *
 * Read out of the running app's compiled stylesheet rather than copied from
 * documentation, because Tailwind v4 restated its palette in OKLCH and the
 * values moved. Any class found in the source that is missing from here fails
 * the last test in this file rather than being quietly skipped.
 */
const PALETTE: Record<string, [number, number, number]> = {
  "red-300": [255, 162, 162],
  "red-400": [255, 100, 103],
  "red-500": [251, 44, 54],
  "red-600": [231, 0, 11],
  "red-700": [193, 0, 10],
  "red-800": [159, 7, 18],
  "red-900": [130, 24, 26],
  "green-400": [5, 223, 114],
  "green-500": [0, 201, 80],
  "green-600": [0, 166, 62],
  "green-700": [0, 130, 54],
  "green-800": [1, 102, 48],
  "green-900": [13, 84, 43],
  "amber-500": [254, 154, 0],
  "amber-600": [225, 113, 0],
  "amber-700": [187, 77, 0],
  "amber-800": [151, 60, 0],
  "amber-900": [123, 51, 6],
  "yellow-500": [240, 177, 0],
  "yellow-600": [208, 135, 0],
  "yellow-700": [166, 95, 0],
  "yellow-800": [137, 75, 0],
  "yellow-900": [115, 62, 10],
  "blue-500": [43, 127, 255],
  "blue-600": [21, 93, 252],
  "brand-300": [147, 197, 253],
  "brand-400": [96, 165, 250],
  "brand-500": [59, 130, 246],
  "brand-600": [37, 99, 235],
  "brand-700": [29, 78, 216],
};

const MIN = 4.5;
const WHITE: [number, number, number] = [255, 255, 255];

function luminance([r, g, b]: [number, number, number]): number {
  const [x, y, z] = [r, g, b].map((raw) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * x + 0.7152 * y + 0.0722 * z;
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function components(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "__tests__" ? [] : components(path);
    }
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/**
 * Every solid fill that sits under white text, with the file and line.
 *
 * The `(?![/\w-])` matters: `bg-red-500/20` is a 20%-opacity tint used as a
 * panel background, not a fill under a label, and folding those in would drown
 * the real findings in false ones.
 */
function whiteOnFill(): { where: string; token: string; state: string }[] {
  const found: { where: string; token: string; state: string }[] = [];
  for (const file of components("src/components")) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (!line.includes("text-white")) return;
      for (const match of line.matchAll(/(hover:|disabled:hover:)?bg-([a-z]+-\d{3})(?![/\w-])/g)) {
        const token = match[2];
        if (!/^(red|green|amber|yellow|blue|brand)-/.test(token)) continue;
        found.push({
          where: `${file}:${index + 1}`,
          token,
          state: match[1] ? "hover" : "resting",
        });
      }
    });
  }
  return found;
}

describe("white text on a coloured fill", () => {
  const fills = whiteOnFill();

  it("finds the buttons at all", () => {
    // If a refactor moves these to a different mechanism this test would pass
    // by finding nothing, which would be worse than failing.
    expect(fills.length).toBeGreaterThan(20);
  });

  it("uses only palette rungs this test knows the value of", () => {
    const unknown = [...new Set(fills.map((f) => f.token))].filter((t) => !(t in PALETTE));
    expect(
      unknown,
      `add these to PALETTE with their sRGB values: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("clears AA in every state, resting and hover", () => {
    const failures = fills
      .filter((f) => f.token in PALETTE)
      .map((f) => ({ ...f, ratio: contrast(WHITE, PALETTE[f.token]) }))
      .filter((f) => f.ratio < MIN)
      .map((f) => `${f.where}  ${f.state} bg-${f.token} is ${f.ratio}:1`);

    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });
});
