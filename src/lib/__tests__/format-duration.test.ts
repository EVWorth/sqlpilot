import { describe, expect, it } from "vitest";
import { formatDurationMs, formatDurationSeconds } from "../format-duration";

describe("formatDurationMs", () => {
  it.each([
    [0, "0ms"],
    [18, "18ms"],
    [999, "999ms"],
    [1000, "1s"],
    [30012, "30s"],
    [51204, "51.2s"],
    [184300, "3m 4s"],
    [7_500_000, "2h 5m"],
    [1_209_644_000, "14d 0h"],
  ])("%d ms is %s", (ms, expected) => {
    expect(formatDurationMs(ms)).toBe(expected);
  });

  it("does not invent a value for nonsense input", () => {
    expect(formatDurationMs(-1)).toBe("—");
    expect(formatDurationMs(Number.NaN)).toBe("—");
  });
});

describe("formatDurationSeconds", () => {
  it.each([
    [0, "0s"],
    [47, "47s"],
    [340, "5m 40s"],
    [1212, "20m 12s"],
    [604812, "7d 0h"],
    [1209644, "14d 0h"],
  ])("%d s is %s", (s, expected) => {
    expect(formatDurationSeconds(s)).toBe(expected);
  });
});
