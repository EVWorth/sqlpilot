import { describe, it, expect } from "vitest";
import { postProcessSQL } from "../sql-post-process";

describe("postProcessSQL", () => {
  describe("backtick-quoted identifiers → lowercase", () => {
    it("lowercases an uppercase backtick identifier", () => {
      expect(postProcessSQL("`YEAR`")).toBe("`year`");
    });

    it("lowercases a mixed-case backtick identifier", () => {
      expect(postProcessSQL("`MyColumn`")).toBe("`mycolumn`");
    });

    it("leaves already-lowercase backtick identifier unchanged", () => {
      expect(postProcessSQL("`year`")).toBe("`year`");
    });

    it("handles multiple backtick identifiers in one query", () => {
      expect(postProcessSQL("SELECT `YEAR`, `MAKE` FROM cars")).toBe(
        "SELECT `year`, `make` FROM cars",
      );
    });
  });

  describe("dot-qualified all-uppercase identifiers → lowercase", () => {
    it("lowercases an all-caps qualifier.IDENTIFIER", () => {
      expect(postProcessSQL("cars.YEAR")).toBe("cars.year");
    });

    it("lowercases multiple dot-qualified identifiers", () => {
      expect(postProcessSQL("SELECT cars.YEAR, cars.MAKE FROM cars")).toBe(
        "SELECT cars.year, cars.make FROM cars",
      );
    });

    it("leaves mixed-case dot-qualified identifiers unchanged (not all-caps)", () => {
      expect(postProcessSQL("cars.MyColumn")).toBe("cars.MyColumn");
      expect(postProcessSQL("cars.myColumn")).toBe("cars.myColumn");
    });

    it("leaves lowercase dot-qualified identifiers unchanged", () => {
      expect(postProcessSQL("cars.year")).toBe("cars.year");
    });
  });

  describe("string literals are not mutated", () => {
    it("does not lowercase content inside single-quoted strings", () => {
      expect(postProcessSQL("WHERE name = 'YEAR'")).toBe("WHERE name = 'YEAR'");
    });

    it("does not apply dot-qualifier rule inside string literals", () => {
      expect(postProcessSQL("WHERE label = 'cars.YEAR'")).toBe("WHERE label = 'cars.YEAR'");
    });

    it("does not lowercase backtick-like text inside string literals", () => {
      // backtick inside a single-quoted string should not be treated as an identifier
      expect(postProcessSQL("WHERE x = 'use `UPPER`'")).toBe("WHERE x = 'use `UPPER`'");
    });

    it("handles escaped single quotes inside strings", () => {
      expect(postProcessSQL("WHERE x = 'it\\'s cars.YEAR'")).toBe(
        "WHERE x = 'it\\'s cars.YEAR'",
      );
    });
  });

  describe("mixed content", () => {
    it("applies rules outside strings but not inside", () => {
      expect(postProcessSQL("SELECT `YEAR` FROM cars WHERE name = 'cars.YEAR'")).toBe(
        "SELECT `year` FROM cars WHERE name = 'cars.YEAR'",
      );
    });

    it("empty string returns empty string", () => {
      expect(postProcessSQL("")).toBe("");
    });

    it("plain SQL without identifiers or strings is unchanged", () => {
      const sql = "SELECT * FROM cars";
      expect(postProcessSQL(sql)).toBe(sql);
    });
  });
});
