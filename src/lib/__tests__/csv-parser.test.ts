import { describe, it, expect } from "vitest";
import { parseCSV } from "../csv-parser";

describe("parseCSV", () => {
  it("should parse simple CSV with header", () => {
    const result = parseCSV("name,age\nAlice,30\nBob,25", {
      delimiter: ",",
      hasHeader: true,
      quoteChar: '"',
    });
    expect(result.headers).toEqual(["name", "age"]);
    expect(result.rows).toEqual([
      ["Alice", "30"],
      ["Bob", "25"],
    ]);
  });

  it("should parse CSV without header", () => {
    const result = parseCSV("Alice,30\nBob,25", {
      delimiter: ",",
      hasHeader: false,
      quoteChar: '"',
    });
    expect(result.headers).toEqual(["column_1", "column_2"]);
    expect(result.rows).toEqual([
      ["Alice", "30"],
      ["Bob", "25"],
    ]);
  });

  it("should handle quoted fields with commas", () => {
    const result = parseCSV('name,address\n"Smith, John","123 Main St"', {
      delimiter: ",",
      hasHeader: true,
      quoteChar: '"',
    });
    expect(result.headers).toEqual(["name", "address"]);
    expect(result.rows).toEqual([["Smith, John", "123 Main St"]]);
  });

  it("should handle escaped quotes", () => {
    const result = parseCSV('val\n"He said ""hello"""', {
      delimiter: ",",
      hasHeader: true,
      quoteChar: '"',
    });
    expect(result.rows).toEqual([['He said "hello"']]);
  });

  it("should handle newlines inside quoted fields", () => {
    const result = parseCSV('a,b\n"line1\nline2",ok', {
      delimiter: ",",
      hasHeader: true,
      quoteChar: '"',
    });
    expect(result.rows).toEqual([["line1\nline2", "ok"]]);
  });

  it("should handle tab delimiter", () => {
    const result = parseCSV("name\tage\nAlice\t30", {
      delimiter: "\t",
      hasHeader: true,
      quoteChar: '"',
    });
    expect(result.headers).toEqual(["name", "age"]);
    expect(result.rows).toEqual([["Alice", "30"]]);
  });

  it("should handle empty input", () => {
    const result = parseCSV("", {
      delimiter: ",",
      hasHeader: true,
      quoteChar: '"',
    });
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("should handle CRLF line endings", () => {
    const result = parseCSV("a,b\r\n1,2\r\n3,4", {
      delimiter: ",",
      hasHeader: true,
      quoteChar: '"',
    });
    expect(result.headers).toEqual(["a", "b"]);
    expect(result.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});
