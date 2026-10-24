import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nothing may be shown only on hover (#784).
 *
 * Row actions are drawn with `opacity-0 group-hover:opacity-100`. When that is
 * all there is, a keyboard user tabs onto a button they cannot see. Every
 * line that reveals something on `group-hover` has to reveal it on focus too:
 * `focus-visible:`, `focus:`, `group-focus-within:`, `group-focus-visible:`,
 * `group-has-[:focus-visible]/name:` and so on, anything with "focus" in the
 * variant. A control the row's own keyboard handling reaches can leave the tab
 * order with `tabIndex={-1}`, but it still shows when its row has focus.
 *
 * Class strings sit on one line in this codebase, so the check is per line.
 */

const COMPONENTS = join(__dirname, "..", "components");

/** `group-hover:opacity-100`, `group-hover/table:opacity-60`, `group-hover:visible`. */
const HOVER_REVEAL = /group-hover(?:\/[\w-]+)?:(?:opacity-[1-9]\d*|visible)\b/;
/** The same reveal under any focus variant. */
const FOCUS_REVEAL = /focus[^\s"'`]*:(?:opacity-[1-9]\d*|visible)\b/;

/**
 * Known exceptions, by file and a piece of the line, each with its reason.
 * Keep this short; fixing the control is better than listing it.
 */
const ALLOWED: { file: string; contains: string; why: string }[] = [
  {
    file: "grid/GridHeaderCell.tsx",
    contains: "opacity-0 transition-opacity group-hover:opacity-100",
    why: "the drag grip is an aria-hidden icon, not a control; the header itself takes focus",
  },
  {
    file: "grid/EditableCell.tsx",
    contains: "hover:opacity-100 group-hover:opacity-60",
    why: "the NULL toggle needs a focus reveal; left to the grid work in flight (#784)",
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function offenders(): string[] {
  const found: string[] = [];
  for (const path of sourceFiles(COMPONENTS)) {
    const file = relative(COMPONENTS, path).split("\\").join("/");
    readFileSync(path, "utf8").split("\n").forEach((line, i) => {
      if (!HOVER_REVEAL.test(line) || FOCUS_REVEAL.test(line)) return;
      if (ALLOWED.some((a) => a.file === file && line.includes(a.contains))) return;
      found.push(`components/${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe("hover-only controls", () => {
  it("reveals on focus whatever it reveals on hover", () => {
    expect(offenders()).toEqual([]);
  });

  it("catches a hover-only reveal and accepts a focus counterpart", () => {
    expect(HOVER_REVEAL.test("opacity-0 group-hover:opacity-100")).toBe(true);
    expect(HOVER_REVEAL.test("opacity-0 group-hover/table:opacity-100")).toBe(true);
    expect(HOVER_REVEAL.test("invisible group-hover:visible")).toBe(true);
    expect(HOVER_REVEAL.test("group-hover:opacity-0")).toBe(false);
    expect(FOCUS_REVEAL.test("focus-visible:opacity-100")).toBe(true);
    expect(FOCUS_REVEAL.test("group-focus-within:opacity-100")).toBe(true);
    expect(FOCUS_REVEAL.test("group-has-[:focus-visible]/table:opacity-100")).toBe(true);
    expect(FOCUS_REVEAL.test("focus-visible:ring-2")).toBe(false);
  });

  it("lists only exceptions that still exist", () => {
    const stale = ALLOWED.filter((a) => !readFileSync(join(COMPONENTS, a.file), "utf8").includes(a.contains));
    expect(stale).toEqual([]);
  });
});
