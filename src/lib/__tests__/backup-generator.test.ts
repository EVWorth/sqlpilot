import { describe, it, expect } from "vitest";

// We test the escapeValue logic and helper functions by importing indirectly
// Since generateBackup depends on Tauri API, we test the pure utility parts

describe("backup-generator value escaping", () => {
  // Re-implement escapeValue here to test it in isolation
  // (same logic as in backup-generator.ts)
  function escapeValue(val: null | boolean | number | string | number[]): string {
    if (val === null) return "NULL";
    if (typeof val === "number") return String(val);
    if (typeof val === "boolean") return val ? "1" : "0";
    if (Array.isArray(val)) {
      const hex = val.map((b) => b.toString(16).padStart(2, "0")).join("");
      return `X'${hex}'`;
    }
    return (
      "'" +
      String(val)
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\0/g, "\\0")
        .replace(/\x1a/g, "\\Z") +
      "'"
    );
  }

  it("should escape null", () => {
    expect(escapeValue(null)).toBe("NULL");
  });

  it("should escape numbers", () => {
    expect(escapeValue(42)).toBe("42");
    expect(escapeValue(3.14)).toBe("3.14");
    expect(escapeValue(0)).toBe("0");
    expect(escapeValue(-1)).toBe("-1");
  });

  it("should escape booleans", () => {
    expect(escapeValue(true)).toBe("1");
    expect(escapeValue(false)).toBe("0");
  });

  it("should escape strings", () => {
    expect(escapeValue("hello")).toBe("'hello'");
    expect(escapeValue("it's")).toBe("'it\\'s'");
    expect(escapeValue("line1\nline2")).toBe("'line1\\nline2'");
    expect(escapeValue("back\\slash")).toBe("'back\\\\slash'");
    expect(escapeValue("null\0byte")).toBe("'null\\0byte'");
    expect(escapeValue("return\r")).toBe("'return\\r'");
  });

  it("should escape binary data as hex", () => {
    expect(escapeValue([0xde, 0xad, 0xbe, 0xef])).toBe("X'deadbeef'");
    expect(escapeValue([0x00, 0xff])).toBe("X'00ff'");
    expect(escapeValue([])).toBe("X''");
  });

  it("should escape SUB character", () => {
    expect(escapeValue("ctrl\x1az")).toBe("'ctrl\\Zz'");
  });

  it("should handle empty string", () => {
    expect(escapeValue("")).toBe("''");
  });
});

describe("backup-generator identifier escaping", () => {
  function escapeIdentifier(name: string): string {
    return "`" + name.replace(/`/g, "``") + "`";
  }

  it("should escape simple identifiers", () => {
    expect(escapeIdentifier("users")).toBe("`users`");
  });

  it("should escape identifiers with backticks", () => {
    expect(escapeIdentifier("my`table")).toBe("`my``table`");
  });

  it("should handle reserved words", () => {
    expect(escapeIdentifier("select")).toBe("`select`");
  });
});
