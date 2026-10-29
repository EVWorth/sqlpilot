import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contrastRatio } from "../../../lib/themes";
import type { QueryResult } from "../../../types";
import { ExplainPanel } from "../ExplainPanel";

// #849: in the light theme the access-type badges were white on pale tints,
// and at 1024px the legend ran off the panel. Real Chromium, the app's
// stylesheet, the light theme.

const state = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: (selector: (s: unknown) => unknown) => selector(state.current),
}));

const COLUMNS = [
  "id",
  "select_type",
  "table",
  "partitions",
  "type",
  "possible_keys",
  "key",
  "key_len",
  "ref",
  "rows",
  "filtered",
  "Extra",
].map((name) => ({ name, data_type: "varchar", nullable: true, is_primary_key: false }));

function plan(): QueryResult {
  return {
    query_id: "p",
    statement_index: 0,
    sql: "",
    columns: COLUMNS,
    rows: [
      [1, "SIMPLE", "o", null, "ALL", null, null, null, null, 1000, 33.3, "Using where"],
      [1, "SIMPLE", "c", null, "eq_ref", "PRIMARY", "PRIMARY", "4", "shop.o.customer_id", 1, 100, null],
    ],
    rows_affected: 0,
    execution_time_ms: 1,
    warnings: [],
    rows_truncated: false,
    truncation_reason: null,
    total_rows_available: null,
  } as QueryResult;
}

/** `rgb(r, g, b)` or `color(srgb r g b)` as hex. */
function hex(css: string): string {
  const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(css);
  const parts = srgb
    ? srgb.slice(1, 4).map((v) => Math.round(Number(v) * 255))
    : (/rgba?\((\d+), (\d+), (\d+)/.exec(css)?.slice(1, 4).map(Number) ?? [0, 0, 0]);
  return "#" + parts.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** The colour an element's background resolves to over the white page. */
function backgroundOver(el: HTMLElement, page: string): string {
  const css = getComputedStyle(el).backgroundColor;
  const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?/.exec(css);
  const rgba = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?/.exec(css);
  const [r, g, b, a] = srgb
    ? [...srgb.slice(1, 4).map((v) => Number(v) * 255), Number(srgb[4] ?? 1)]
    : rgba
    ? [...rgba.slice(1, 4).map(Number), Number(rgba[4] ?? 1)]
    : [255, 255, 255, 0];
  const base = [1, 3, 5].map((i) => parseInt(page.slice(i, i + 2), 16));
  return "#" + [r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)).toString(16).padStart(2, "0")).join("");
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.body.style.width = "";
});

describe("ExplainPanel in the light theme (#849)", () => {
  it("draws the ALL badge at AA contrast", () => {
    document.documentElement.setAttribute("data-theme", "light");
    state.current = { explainResult: plan(), explainAnalyze: false, explainTabular: true, explainFormat: "classic" };
    render(<ExplainPanel />);

    const legend = screen.getByTestId("access-type-legend");
    const badge = [...legend.querySelectorAll("span")].find((s) => s.textContent === "ALL");
    if (!badge) throw new Error("no ALL badge in the legend");
    const fg = hex(getComputedStyle(badge).color);
    const bg = backgroundOver(badge, "#f8f9fa");

    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("wraps the legend inside the panel at 1024px", () => {
    document.documentElement.setAttribute("data-theme", "light");
    document.body.style.width = "1024px";
    state.current = { explainResult: plan(), explainAnalyze: false, explainTabular: true, explainFormat: "classic" };
    const { container } = render(<ExplainPanel />);

    const legend = screen.getByTestId("access-type-legend");
    const panel = container.firstElementChild as HTMLElement;
    const last = legend.lastElementChild as HTMLElement;
    expect(last.getBoundingClientRect().right).toBeLessThanOrEqual(panel.getBoundingClientRect().right + 0.5);
  });
});
