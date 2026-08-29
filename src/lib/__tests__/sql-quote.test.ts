import { describe, expect, it } from "vitest";
import { quoteIdentifier, quoteStringLiteral } from "../sql-quote";

describe("quoteIdentifier", () => {
  it("wraps a name in backticks", () => {
    expect(quoteIdentifier("users")).toBe("`users`");
    expect(quoteIdentifier("my_table")).toBe("`my_table`");
  });

  it("doubles an embedded backtick", () => {
    expect(quoteIdentifier("a`b")).toBe("`a``b`");
  });

  it("leaves a backslash alone", () => {
    // A backslash is an ordinary character inside a backtick-quoted
    // identifier — escaping it would change the name.
    expect(quoteIdentifier("a\\b")).toBe("`a\\b`");
  });

  it("quotes a database name that would otherwise break the statement", () => {
    // MySQL permits CREATE DATABASE `we``ird`. Hand-rolled backticks without
    // doubling turned `GRANT ... ON `we`ird`.*` into a parse error.
    expect(quoteIdentifier("we`ird")).toBe("`we``ird`");
  });
});

describe("quoteStringLiteral", () => {
  it("wraps a value in single quotes", () => {
    expect(quoteStringLiteral("hunter2")).toBe("'hunter2'");
  });

  it("escapes a single quote", () => {
    expect(quoteStringLiteral("it's")).toBe("'it\\'s'");
  });

  it("escapes a backslash", () => {
    // The bug this function exists for. MySQL treats a backslash as an escape
    // inside a string literal unless NO_BACKSLASH_ESCAPES is set, which is off
    // by default. Quoting `pa\ss` as 'pa\ss' stores `pass` — the account gets
    // a password the user never typed and cannot log in with.
    expect(quoteStringLiteral("pa\\ss")).toBe("'pa\\\\ss'");
  });

  it("escapes backslashes before quotes, so its own escapes are not re-escaped", () => {
    expect(quoteStringLiteral("a\\'b")).toBe("'a\\\\\\'b'");
  });

  it("escapes the control characters MySQL would otherwise interpret", () => {
    expect(quoteStringLiteral("a\nb")).toBe("'a\\nb'");
    expect(quoteStringLiteral("a\rb")).toBe("'a\\rb'");
    expect(quoteStringLiteral("a\0b")).toBe("'a\\0b'");
    expect(quoteStringLiteral("a\x1ab")).toBe("'a\\Zb'");
  });

  it("passes an ordinary password through unchanged", () => {
    expect(quoteStringLiteral("Str0ng!Pass#2026")).toBe("'Str0ng!Pass#2026'");
  });
});
