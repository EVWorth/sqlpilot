import { beforeEach, describe, expect, it } from "vitest";
import { clampWidth, defaultWidth, loadWidth, MIN_WIDTH, saveWidth } from "../agent-panel-width";

beforeEach(() => localStorage.clear());

describe("the agent panel's width", () => {
  it("opens at 380px when the window has room", () => {
    expect(defaultWidth(1920)).toBe(380);
    expect(defaultWidth(1280)).toBe(380);
  });

  it("opens narrower in a 1024px window, so the editor keeps its room", () => {
    expect(defaultWidth(1024)).toBeLessThan(380);
    expect(defaultWidth(1024)).toBeGreaterThanOrEqual(MIN_WIDTH);
  });

  it("never goes below the minimum or above half the window", () => {
    expect(clampWidth(100, 1280)).toBe(MIN_WIDTH);
    expect(clampWidth(2000, 1280)).toBe(640);
  });

  it("remembers the width the user chose, fitted to the window", () => {
    saveWidth(500);
    expect(loadWidth(1920)).toBe(500);
    // The same width in a window too small for it is narrowed, not kept.
    expect(loadWidth(800)).toBe(400);
  });

  it("falls back to the default for nothing stored, or nonsense", () => {
    expect(loadWidth(1920)).toBe(380);
    localStorage.setItem("sqlpilot-agent-panel-width", "wide");
    expect(loadWidth(1920)).toBe(380);
  });
});
