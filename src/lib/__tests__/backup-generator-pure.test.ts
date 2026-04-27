import { describe, it, expect } from "vitest";
import { escapeValue, escapeIdentifier } from "../backup-generator";

describe("escapeValue", () => {
  it("returns NULL for null", () => {
    expect(escapeValue(null)).toBe("NULL");
  });

  it("returns number as string", () => {
    expect(escapeValue(42)).toBe("42");
    expect(escapeValue(0)).toBe("0");
    expect(escapeValue(-3.14)).toBe("-3.14");
  });

  it("returns 1 or 0 for booleans", () => {
    expect(escapeValue(true)).toBe("1");
    expect(escapeValue(false)).toBe("0");
  });

  it("returns hex for binary arrays", () => {
    expect(escapeValue([72, 101, 108, 108, 111])).toBe("X'48656c6c6f'");
  });

  it("escapes single quotes", () => {
    expect(escapeValue("it's")).toBe("'it\\'s'");
  });

  it("escapes backslashes", () => {
    expect(escapeValue("a\\b")).toBe("'a\\\\b'");
  });

  it("escapes newlines and carriage returns", () => {
    expect(escapeValue("a\nb")).toBe("'a\\nb'");
    expect(escapeValue("a\rb")).toBe("'a\\rb'");
  });

  it("escapes null bytes", () => {
    expect(escapeValue("a\0b")).toBe("'a\\0b'");
  });

  it("escapes control-Z", () => {
    expect(escapeValue("a\x1ab")).toBe("'a\\Zb'");
  });

  it("wraps strings in quotes", () => {
    expect(escapeValue("hello")).toBe("'hello'");
  });
});

describe("escapeIdentifier", () => {
  it("wraps identifier in backticks", () => {
    expect(escapeIdentifier("my_table")).toBe("`my_table`");
  });

  it("doubles backticks inside names", () => {
    expect(escapeIdentifier("a`b")).toBe("`a``b`");
  });
});
