import { describe, expect, it } from "vitest";
import { truncationMessage } from "../truncation";

describe("truncationMessage", () => {
  it("does not suggest a LIMIT when memory was the cap", () => {
    // The whole point of #413. Someone already running LIMIT 10000 who is
    // told to "add a LIMIT clause" raises the limit, which asks for more of
    // the resource that just ran out.
    const msg = truncationMessage(8_412, "memory_guard");
    expect(msg).toContain("low on memory");
    expect(msg).toContain("A larger LIMIT will not help");
    expect(msg).not.toMatch(/add a LIMIT clause/i);
  });

  it("names the row limit, and where to change it, when that was the cap", () => {
    const msg = truncationMessage(1000, "row_limit");
    expect(msg).toContain("row limit");
    expect(msg).toContain("Settings");
  });

  it("claims nothing about why when the reason is absent", () => {
    // A result from a backend predating truncation_reason, or one built by
    // hand. Better to say less than to guess and be wrong.
    for (const reason of [null, undefined] as const) {
      const msg = truncationMessage(50, reason);
      expect(msg).toBe("Results truncated to 50 rows.");
    }
  });

  it("groups the row count for readability", () => {
    expect(truncationMessage(1234567, "row_limit")).toContain("1,234,567");
  });
});
