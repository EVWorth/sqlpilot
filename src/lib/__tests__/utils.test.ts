import { describe, it, expect } from "vitest";
import { cn } from "../utils";

describe("cn", () => {
  it("merges simple class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("handles conditional classes", () => {
    expect(cn("base", true && "conditional", false && "never")).toBe(
      "base conditional",
    );
  });

  it("handles array inputs", () => {
    expect(cn(["a", "b"], "c")).toBe("a b c");
  });

  it("does not deduplicate identical non-Tailwind classes", () => {
    expect(cn("foo", "foo")).toBe("foo foo");
  });

  it("handles tailwind conflicts", () => {
    expect(cn("p-4", "p-8")).toBe("p-8");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("handles null and undefined", () => {
    expect(cn(null, undefined, "foo")).toBe("foo");
  });

  it("handles empty input", () => {
    expect(cn()).toBe("");
  });
});
