import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Status colours come from the theme, not from the palette.
 *
 * A hardcoded `text-red-400` is the same colour in every theme by definition,
 * which is how #218 happened: the Compare screen rendered labels that were
 * legible in dark mode and invisible in light. That was fixed at the instance
 * and the cause stayed in 46 files.
 *
 * It is also what stands between this app and custom themes (#350). A theme
 * can only restyle what goes through tokens, so every literal is a patch of
 * the interface a user's theme cannot reach.
 *
 * What this bans, and why only this:
 *
 * - `text-`, `border-` and `ring-` in a hue that has a semantic token. There
 *   is a right answer for these — `var(--color-error)` and friends — and it is
 *   both theme-aware and covered by the contrast test.
 * - Tinted backgrounds (`bg-red-500/10`). Those are the `surface-*` and
 *   `edge-*` utilities now, mixed from the token so a theme's error colour
 *   brings its own wash with it.
 *
 * What it deliberately allows:
 *
 * - Solid `bg-<hue>-<rung>` fills. A button with white text needs a colour
 *   far darker than any `--color-*` token, which are foregrounds; those are
 *   guarded by `button-contrast.test.ts` instead, which checks the thing that
 *   actually matters about them.
 * - Hues with no semantic meaning in this app — purple, pink, orange, grey.
 *   Forcing those through tokens would mean inventing tokens for "the colour
 *   of a subquery badge", which is not a concept the theme system should have.
 */

/** Hues that have a `--color-*` token standing behind them. */
const SEMANTIC = "red|green|amber|yellow|blue";

const BANNED = [
  {
    pattern: new RegExp(
      `(?<![\\w-])(?:[a-z-]+:)?(?:text|border|ring)-(?:${SEMANTIC})-\\d{3}(?:/\\d+)?(?![\\w/-])`,
      "g",
    ),
    instead: "text-[var(--color-error)] / edge-warning / etc.",
  },
  {
    pattern: new RegExp(`(?<![\\w-])(?:[a-z-]+:)?bg-(?:${SEMANTIC})-\\d{3}/\\d+(?![\\w/-])`, "g"),
    instead: "surface-error / surface-warning / surface-success",
  },
];

/**
 * Literals kept on purpose, each with the reason.
 *
 * Adding to this list is allowed and should be rare; it is here so that an
 * exception has to be written down rather than simply not noticed.
 */
const ALLOWED: Record<string, string> = {
  // Empty, and that is the intended state. The one candidate — the sponsor
  // button's brand yellow — turned out not to need an entry, because a solid
  // fill was never banned in the first place.
};

function componentFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : componentFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("status colours", () => {
  const files = componentFiles("src/components");

  it("reads the components at all", () => {
    // A guard that finds no files passes trivially, which is worse than
    // failing — this project has shipped one of those already.
    expect(files.length).toBeGreaterThan(50);
  });

  it("come from the theme, not from the palette", () => {
    const offences: string[] = [];

    for (const file of files) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        for (const { pattern, instead } of BANNED) {
          for (const match of line.matchAll(pattern)) {
            if (ALLOWED[file]) continue;
            offences.push(`${file}:${index + 1}  ${match[0]}  → use ${instead}`);
          }
        }
      });
    }

    expect(offences, `\n${offences.join("\n")}\n`).toEqual([]);
  });

  it("keeps the exception list honest", () => {
    // An allowance for a file that no longer needs one is a comment that has
    // stopped being true.
    const unnecessary = Object.keys(ALLOWED).filter((file) => {
      const text = readFileSync(file, "utf8");
      // A fresh regex per check: these carry the `g` flag, and `test` on a
      // global regex advances `lastIndex`, so a shared one answers differently
      // the second time it is asked the same question.
      return !BANNED.some(({ pattern }) => new RegExp(pattern.source).test(text));
    });
    expect(unnecessary, `these no longer need an exception: ${unnecessary.join(", ")}`).toEqual([]);
  });
});
