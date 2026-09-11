/**
 * Themes as data, so there can be more than two of them.
 *
 * NFR-5.2 asks for a CSS-based theme system, an editor with live preview, and
 * import/export. What existed was `dark` and `light` written into globals.css
 * and a `system` mode resolving to one of them — there was nothing a user
 * could edit, add, or take with them (#350).
 *
 * A theme is a set of CSS custom properties, which is what the whole
 * stylesheet already reads from. Applying one writes those properties onto
 * the document element; the stylesheet's own `[data-theme]` blocks stay as the
 * floor, so a theme that omits a token inherits a sane value rather than
 * rendering white on white.
 */

/**
 * Every colour a theme controls.
 *
 * `brand-300` through `brand-700` are in here because components name them
 * directly — `bg-brand-600`, `text-brand-400` — so a theme that could not set
 * them would leave its accent colour fighting a blue that came from nowhere.
 */
export const THEME_TOKENS = [
  "bg-primary",
  "bg-secondary",
  "bg-tertiary",
  "border",
  "text-primary",
  "text-secondary",
  "text-muted",
  "accent",
  "success",
  "warning",
  "error",
  "brand-300",
  "brand-400",
  "brand-500",
  "brand-600",
  "brand-700",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/** What each token is for, shown beside its swatch in the editor. */
export const TOKEN_LABELS: Record<ThemeToken, string> = {
  "bg-primary": "Background",
  "bg-secondary": "Panels",
  "bg-tertiary": "Raised surfaces",
  "border": "Borders",
  "text-primary": "Text",
  "text-secondary": "Secondary text",
  "text-muted": "Muted text",
  "accent": "Accent",
  "success": "Success",
  "warning": "Warning",
  "error": "Error",
  "brand-300": "Brand, lightest",
  "brand-400": "Brand, light",
  "brand-500": "Brand",
  "brand-600": "Brand, dark",
  "brand-700": "Brand, darkest",
};

export interface Theme {
  id: string;
  name: string;
  /**
   * Which way round the theme reads.
   *
   * Drives `color-scheme`, so native scrollbars and form controls match, and
   * decides which Monaco theme the editor uses. A theme cannot set those
   * itself, and getting them wrong is more jarring than any colour is.
   */
  base: "dark" | "light";
  colors: Record<ThemeToken, string>;
  /** True for the themes that ship with the app and cannot be edited away. */
  builtIn?: boolean;
}

const DARK: Record<ThemeToken, string> = {
  "bg-primary": "#0a0a0f",
  "bg-secondary": "#111118",
  "bg-tertiary": "#1a1a24",
  "border": "#2a2a3a",
  "text-primary": "#e4e4ef",
  "text-secondary": "#9898aa",
  "text-muted": "#8b8ba0",
  "accent": "#3b82f6",
  "success": "#22c55e",
  "warning": "#eab308",
  "error": "#ef4444",
  "brand-300": "#93c5fd",
  "brand-400": "#60a5fa",
  "brand-500": "#3b82f6",
  "brand-600": "#2563eb",
  "brand-700": "#1d4ed8",
};

const LIGHT: Record<ThemeToken, string> = {
  "bg-primary": "#ffffff",
  "bg-secondary": "#f8f9fa",
  "bg-tertiary": "#f0f1f3",
  "border": "#d1d5db",
  "text-primary": "#1f2937",
  "text-secondary": "#4b5563",
  "text-muted": "#9ca3af",
  "accent": "#2563eb",
  "success": "#16a34a",
  "warning": "#ca8a04",
  "error": "#dc2626",
  "brand-300": "#93c5fd",
  "brand-400": "#60a5fa",
  "brand-500": "#3b82f6",
  "brand-600": "#2563eb",
  "brand-700": "#1d4ed8",
};

/**
 * The themes that ship with the app.
 *
 * Three beyond the originals, chosen for what they do rather than for count:
 * two long-standing palettes people already have opinions about, and a
 * high-contrast pair, which is an accessibility need rather than a taste.
 */
export const BUILT_IN_THEMES: Theme[] = [
  { id: "dark", name: "Dark", base: "dark", colors: DARK, builtIn: true },
  { id: "light", name: "Light", base: "light", colors: LIGHT, builtIn: true },
  {
    id: "nord",
    name: "Nord",
    base: "dark",
    builtIn: true,
    colors: {
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
      "brand-300": "#a3d3de",
      "brand-400": "#88c0d0",
      "brand-500": "#81a1c1",
      "brand-600": "#5e81ac",
      "brand-700": "#4c6a8f",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    base: "light",
    builtIn: true,
    colors: {
      "bg-primary": "#fdf6e3",
      "bg-secondary": "#eee8d5",
      "bg-tertiary": "#e4ddc8",
      "border": "#d3cbb7",
      "text-primary": "#073642",
      "text-secondary": "#586e75",
      "text-muted": "#93a1a1",
      "accent": "#268bd2",
      "success": "#859900",
      "warning": "#b58900",
      "error": "#dc322f",
      "brand-300": "#7fc4ee",
      "brand-400": "#4ba7e0",
      "brand-500": "#268bd2",
      "brand-600": "#1f6fa8",
      "brand-700": "#18567f",
    },
  },
  {
    id: "high-contrast",
    name: "High Contrast",
    base: "dark",
    builtIn: true,
    colors: {
      // Pure black and white, and borders that are actually visible. The
      // default dark theme's #2a2a3a border on #0a0a0f is around 1.3:1, which
      // is not a line anyone can reliably see.
      "bg-primary": "#000000",
      "bg-secondary": "#0d0d0d",
      "bg-tertiary": "#1a1a1a",
      "border": "#6a6a6a",
      "text-primary": "#ffffff",
      "text-secondary": "#e0e0e0",
      "text-muted": "#b8b8b8",
      "accent": "#4aa3ff",
      "success": "#3fdb6a",
      "warning": "#ffd23f",
      "error": "#ff6b6b",
      "brand-300": "#bcdcff",
      "brand-400": "#8ec5ff",
      "brand-500": "#4aa3ff",
      "brand-600": "#1a86ff",
      "brand-700": "#0066d6",
    },
  },
];

export function builtInTheme(id: string): Theme | undefined {
  return BUILT_IN_THEMES.find((t) => t.id === id);
}

/**
 * Write a theme onto the document.
 *
 * Tokens are set as inline custom properties rather than by swapping a
 * stylesheet, so a theme applies without a reflow of the whole page and an
 * edit shows up as it is typed.
 */
export function applyThemeColors(theme: Theme, root: HTMLElement): void {
  root.dataset.theme = theme.base;
  for (const token of THEME_TOKENS) {
    const value = theme.colors[token];
    if (value) root.style.setProperty(`--color-${token}`, value);
  }
}

/** Remove every token this module sets, falling back to the stylesheet. */
export function clearThemeColors(root: HTMLElement): void {
  for (const token of THEME_TOKENS) {
    root.style.removeProperty(`--color-${token}`);
  }
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** True for a value safe to put in a CSS custom property. */
export function isColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value.trim());
}

export interface ThemeParseError {
  error: string;
}

/**
 * Read a theme from a file someone hands us.
 *
 * Validated field by field rather than cast, because this is the one place
 * a stranger's data reaches the stylesheet: a value that is not a colour
 * would be written into a custom property verbatim, and `--color-bg-primary:
 * url(https://…)` is a request the app would then make on their behalf.
 */
export function parseTheme(json: string): Theme | ThemeParseError {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { error: "That file is not valid JSON." };
  }
  if (typeof raw !== "object" || raw === null) {
    return { error: "A theme file must contain a single theme object." };
  }

  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : null;
  if (!name) return { error: "The theme has no name." };

  const base = obj.base === "light" ? "light" : obj.base === "dark" ? "dark" : null;
  if (!base) return { error: `"base" must be "dark" or "light".` };

  if (typeof obj.colors !== "object" || obj.colors === null) {
    return { error: "The theme has no colors." };
  }
  const source = obj.colors as Record<string, unknown>;

  const colors = {} as Record<ThemeToken, string>;
  const bad: string[] = [];
  for (const token of THEME_TOKENS) {
    const value = source[token];
    if (value === undefined) {
      // Missing tokens fall back to the base theme rather than failing the
      // import: a theme written against an older version of the app should
      // still load, with the new tokens taking sensible values.
      colors[token] = (base === "dark" ? DARK : LIGHT)[token];
      continue;
    }
    if (!isColor(value)) {
      bad.push(token);
      continue;
    }
    colors[token] = value.trim();
  }
  if (bad.length > 0) {
    return { error: `Not a colour: ${bad.join(", ")}. Use hex, like #1a1a24.` };
  }

  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : slug(name),
    name,
    base,
    colors,
  };
}

/** What gets written to a .json file, without the app's own bookkeeping. */
export function serializeTheme(theme: Theme): string {
  return JSON.stringify(
    { name: theme.name, base: theme.base, colors: theme.colors },
    null,
    2,
  ) + "\n";
}

/** A filesystem- and id-safe form of a name. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "theme";
}

/**
 * The relative luminance of a hex colour, per WCAG.
 *
 * Used to warn about a contrast that cannot be read, which is the one thing a
 * theme editor can get wrong that no amount of taste excuses.
 */
export function luminance(hex: string): number {
  const value = hex.trim().replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(full.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for body text. */
export const MIN_TEXT_CONTRAST = 4.5;
