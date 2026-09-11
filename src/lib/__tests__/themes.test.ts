import { describe, expect, it } from "vitest";
import {
  applyThemeColors,
  BUILT_IN_THEMES,
  builtInTheme,
  clearThemeColors,
  contrastRatio,
  isColor,
  MIN_TEXT_CONTRAST,
  parseTheme,
  serializeTheme,
  slug,
  type Theme,
  THEME_TOKENS,
  TOKEN_LABELS,
} from "../themes";

const theme = (over: Partial<Theme> = {}): Theme => ({
  ...BUILT_IN_THEMES[0],
  builtIn: false,
  ...over,
});

describe("themes (#350)", () => {
  describe("the built-ins", () => {
    it("gives every token a colour", () => {
      // A missing token leaves whatever the last theme set, which is how you
      // get white text on a white panel.
      for (const t of BUILT_IN_THEMES) {
        for (const token of THEME_TOKENS) {
          expect(isColor(t.colors[token]), `${t.id}.${token}`).toBe(true);
        }
      }
    });

    it("labels every token, so the editor has nothing unnamed", () => {
      for (const token of THEME_TOKENS) {
        expect(TOKEN_LABELS[token]).toBeTruthy();
      }
    });

    it("has unique ids", () => {
      const ids = BUILT_IN_THEMES.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("keeps body text readable", () => {
      // WCAG AA. A theme that ships with the app has no excuse for failing
      // it, and this is the one thing taste does not cover.
      for (const t of BUILT_IN_THEMES) {
        expect(
          contrastRatio(t.colors["text-primary"], t.colors["bg-primary"]),
          `${t.id}: text on background`,
        ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    });

    it("keeps secondary text readable too", () => {
      for (const t of BUILT_IN_THEMES) {
        expect(
          contrastRatio(t.colors["text-secondary"], t.colors["bg-secondary"]),
          `${t.id}: secondary text on panels`,
        ).toBeGreaterThanOrEqual(3);
      }
    });

    it("gives High Contrast a border you can actually see", () => {
      // The default dark theme's border sits at about 1.3:1, which is not a
      // line anyone can rely on.
      const hc = builtInTheme("high-contrast")!;
      expect(contrastRatio(hc.colors.border, hc.colors["bg-primary"])).toBeGreaterThan(3);
    });

    it("finds one by id, and nothing for an unknown one", () => {
      expect(builtInTheme("nord")?.name).toBe("Nord");
      expect(builtInTheme("nope")).toBeUndefined();
    });
  });

  describe("applying", () => {
    it("writes every token and the base", () => {
      const root = document.createElement("div");

      applyThemeColors(builtInTheme("nord")!, root);

      expect(root.dataset.theme).toBe("dark");
      expect(root.style.getPropertyValue("--color-bg-primary")).toBe("#2e3440");
      expect(root.style.getPropertyValue("--color-brand-500")).toBe("#81a1c1");
    });

    it("falls back to the stylesheet when cleared", () => {
      const root = document.createElement("div");
      applyThemeColors(builtInTheme("nord")!, root);

      clearThemeColors(root);

      for (const token of THEME_TOKENS) {
        expect(root.style.getPropertyValue(`--color-${token}`)).toBe("");
      }
    });
  });

  describe("parseTheme", () => {
    const valid = JSON.parse(serializeTheme(theme({ name: "Mine" })));

    it("round-trips a theme it exported", () => {
      const parsed = parseTheme(serializeTheme(theme({ name: "Mine" })));
      expect("error" in parsed).toBe(false);
      if ("error" in parsed) return;
      expect(parsed.name).toBe("Mine");
      expect(parsed.colors["bg-primary"]).toBe(BUILT_IN_THEMES[0].colors["bg-primary"]);
    });

    it("names the file's own id, or makes one from the name", () => {
      const withId = parseTheme(JSON.stringify({ ...valid, id: "custom-one" }));
      expect("error" in withId ? null : withId.id).toBe("custom-one");
      const withoutId = parseTheme(JSON.stringify({ ...valid, name: "My Theme!" }));
      expect("error" in withoutId ? null : withoutId.id).toBe("my-theme");
    });

    it("fills in a token the file does not have", () => {
      // A theme written against an older version should still load, with new
      // tokens taking sensible values rather than the import failing.
      const partial = { ...valid, colors: { ...valid.colors } };
      delete partial.colors["brand-700"];

      const parsed = parseTheme(JSON.stringify(partial));

      expect("error" in parsed).toBe(false);
      if ("error" in parsed) return;
      expect(isColor(parsed.colors["brand-700"])).toBe(true);
    });

    describe("refuses", () => {
      it("something that is not JSON", () => {
        expect(parseTheme("not json")).toEqual({ error: "That file is not valid JSON." });
      });

      it("JSON that is not an object", () => {
        expect("error" in parseTheme("[]")).toBe(true);
        expect("error" in parseTheme("42")).toBe(true);
        expect("error" in parseTheme("null")).toBe(true);
      });

      it("a theme with no name", () => {
        expect("error" in parseTheme(JSON.stringify({ ...valid, name: "   " }))).toBe(true);
      });

      it("a base that is neither dark nor light", () => {
        expect("error" in parseTheme(JSON.stringify({ ...valid, base: "beige" }))).toBe(true);
      });

      it("a theme with no colors", () => {
        expect("error" in parseTheme(JSON.stringify({ ...valid, colors: null }))).toBe(true);
      });

      it.each([
        ["a CSS function", "url(https://example.com/x.png)"],
        ["a named colour", "rebeccapurple"],
        ["something with a semicolon", "#fff; background: url(//evil)"],
        ["a number", 255],
        ["nothing at all", ""],
      ])("%s where a colour should be", (_name, value) => {
        // This is the one place a stranger's data reaches the stylesheet.
        // `--color-bg-primary: url(https://…)` is a request the app would
        // then make on their behalf.
        const parsed = parseTheme(
          JSON.stringify({ ...valid, colors: { ...valid.colors, "bg-primary": value } }),
        );
        expect("error" in parsed).toBe(true);
        if (!("error" in parsed)) return;
        expect(parsed.error).toContain("bg-primary");
      });

      it("naming every bad token at once, rather than one per attempt", () => {
        const parsed = parseTheme(JSON.stringify({
          ...valid,
          colors: { ...valid.colors, "bg-primary": "red", "border": "blue" },
        }));
        if (!("error" in parsed)) throw new Error("expected a refusal");
        expect(parsed.error).toContain("bg-primary");
        expect(parsed.error).toContain("border");
      });
    });

    it("accepts the hex forms a colour picker produces", () => {
      for (const value of ["#fff", "#FFFFFF", "#ffffffcc"]) {
        expect(isColor(value), value).toBe(true);
      }
    });
  });

  describe("serializeTheme", () => {
    it("writes only what a theme file should carry", () => {
      const written = JSON.parse(serializeTheme(theme({ name: "Mine", builtIn: true })));
      expect(Object.keys(written).sort()).toEqual(["base", "colors", "name"]);
    });

    it("ends with a newline, as files do", () => {
      expect(serializeTheme(theme()).endsWith("\n")).toBe(true);
    });
  });

  describe("slug", () => {
    it.each([
      ["My Theme", "my-theme"],
      ["  Spaces  ", "spaces"],
      ["Ünïcödé!!", "n-c-d"],
      ["!!!", "theme"],
      ["", "theme"],
    ])("%s", (input, expected) => {
      expect(slug(input)).toBe(expected);
    });
  });

  describe("contrastRatio", () => {
    it("is 21 for black on white", () => {
      expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    });

    it("is 1 for a colour against itself", () => {
      expect(contrastRatio("#3b82f6", "#3b82f6")).toBeCloseTo(1, 5);
    });

    it("does not care which way round the arguments go", () => {
      expect(contrastRatio("#000", "#fff")).toBeCloseTo(contrastRatio("#fff", "#000"), 5);
    });

    it("reads three-digit hex the same as six", () => {
      expect(contrastRatio("#fff", "#000")).toBeCloseTo(contrastRatio("#ffffff", "#000000"), 5);
    });
  });
});

describe("the stylesheet floor", () => {
  it("matches the dark and light themes it stands in for", async () => {
    // globals.css is what the app looks like between the stylesheet loading
    // and the first script running, and it is the fallback for a theme that
    // omits a token. Drift shows up as a flash of the wrong colour.
    const css = (await import("node:fs")).readFileSync("src/styles/globals.css", "utf8");

    for (const [selector, id] of [["[data-theme=\"dark\"]", "dark"], ["[data-theme=\"light\"]", "light"]] as const) {
      const block = css.slice(css.indexOf(selector));
      const theme = builtInTheme(id)!;
      for (const token of ["bg-primary", "bg-secondary", "border", "text-primary", "accent"]) {
        const match = new RegExp(`--color-${token}:\\s*([^;]+);`).exec(block);
        expect(match?.[1].trim().toLowerCase(), `${id}/${token}`)
          .toBe(theme.colors[token as keyof typeof theme.colors].toLowerCase());
      }
    }
  });
});
