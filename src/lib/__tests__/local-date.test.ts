import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDayEnd, localDayStart, toLocalYmd } from "../local-date";

describe("local-date", () => {
  let savedTz: string | undefined;
  beforeEach(() => {
    savedTz = process.env.TZ;
  });
  afterEach(() => {
    process.env.TZ = savedTz;
  });

  it("bounds a day by local midnight, not UTC (#836)", () => {
    // Pacific daylight time, UTC-7 on this date.
    process.env.TZ = "America/Los_Angeles";
    expect(localDayStart("2026-10-21")).toBe("2026-10-21T07:00:00.000Z");
    expect(localDayEnd("2026-10-21")).toBe("2026-10-22T06:59:59.999Z");
  });

  it("matches the UTC bounds in UTC", () => {
    process.env.TZ = "UTC";
    expect(localDayStart("2026-01-03")).toBe("2026-01-03T00:00:00.000Z");
    expect(localDayEnd("2026-01-03")).toBe("2026-01-03T23:59:59.999Z");
  });

  it("shows a stored bound as the local day it was picked from", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(toLocalYmd(localDayStart("2026-10-21"))).toBe("2026-10-21");
    expect(toLocalYmd(localDayEnd("2026-10-21"))).toBe("2026-10-21");
  });

  it("returns empty for empty or malformed input", () => {
    expect(localDayStart("")).toBe("");
    expect(localDayEnd("21/10/2026")).toBe("");
    expect(toLocalYmd("")).toBe("");
    expect(toLocalYmd("not a date")).toBe("");
  });
});
