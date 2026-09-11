import { describe, expect, it } from "vitest";
import {
  type ColumnFilter,
  defaultOperator,
  describeFilter,
  type FilterOperator,
  isActiveFilter,
  matchesFilter,
  operatorsFor,
} from "../grid-filter";

const f = (operator: FilterOperator, value = "", value2?: string): ColumnFilter => ({
  operator,
  value,
  value2,
});

describe("grid-filter (#391)", () => {
  describe("operatorsFor", () => {
    it("leads with comparisons on numeric and date columns", () => {
      expect(defaultOperator("int")).toBe("gt");
      expect(defaultOperator("decimal")).toBe("gt");
      expect(defaultOperator("datetime")).toBe("gt");
      expect(defaultOperator("timestamp")).toBe("gt");
    });

    it("leads with contains on text columns", () => {
      expect(defaultOperator("varchar")).toBe("contains");
      expect(defaultOperator(undefined)).toBe("contains");
    });

    it("offers every operator on every column", () => {
      // `> 'm'` is a real question to ask of a surname; only the order changes.
      expect(operatorsFor("varchar").sort()).toEqual(operatorsFor("int").sort());
      expect(operatorsFor("varchar")).toContain("between");
      expect(operatorsFor("int")).toContain("contains");
    });
  });

  describe("matchesFilter", () => {
    it("matches text case-insensitively", () => {
      expect(matchesFilter("Alice", f("contains", "ali"))).toBe(true);
      expect(matchesFilter("Alice", f("equals", "alice"))).toBe(true);
      expect(matchesFilter("Alice", f("startsWith", "AL"))).toBe(true);
      expect(matchesFilter("Alice", f("endsWith", "CE"))).toBe(true);
      expect(matchesFilter("Alice", f("contains", "bob"))).toBe(false);
    });

    it("negates", () => {
      expect(matchesFilter("Alice", f("notContains", "bob"))).toBe(true);
      expect(matchesFilter("Alice", f("notEquals", "alice"))).toBe(false);
    });

    it("matches a regex, and shows everything while one is half-typed", () => {
      expect(matchesFilter("a1b", f("regex", "^a\\db$"))).toBe(true);
      // Emptying the grid on every keystroke that lands mid-pattern would make
      // the input unusable.
      expect(matchesFilter("anything", f("regex", "a(b"))).toBe(true);
    });

    describe("NULL", () => {
      it("is found only by isNull", () => {
        expect(matchesFilter(null, f("isNull"))).toBe(true);
        expect(matchesFilter("x", f("isNull"))).toBe(false);
        expect(matchesFilter(null, f("isNotNull"))).toBe(false);
        expect(matchesFilter("x", f("isNotNull"))).toBe(true);
      });

      it("does not slip through a negated filter", () => {
        // SQL agrees: "does not equal x" must not start reporting rows whose
        // value is unknown.
        expect(matchesFilter(null, f("notEquals", "x"))).toBe(false);
        expect(matchesFilter(null, f("notContains", "x"))).toBe(false);
        expect(matchesFilter(undefined, f("contains", ""))).toBe(false);
      });
    });

    describe("ordered comparisons", () => {
      it("compares numbers as numbers", () => {
        expect(matchesFilter(9, f("lt", "10"))).toBe(true);
        expect(matchesFilter(9, f("gt", "10"))).toBe(false);
        expect(matchesFilter(10, f("gte", "10"))).toBe(true);
        expect(matchesFilter(10, f("lte", "10"))).toBe(true);
      });

      it("compares a BIGINT carried as a string as a number", () => {
        // BIGINT and DECIMAL travel as strings so JSON cannot truncate them;
        // comparing those as text makes '9' > '10'.
        expect(matchesFilter("9", f("lt", "10"))).toBe(true);
        expect(matchesFilter("100", f("gt", "99"))).toBe(true);
      });

      it("falls back to text when either side is not a number", () => {
        expect(matchesFilter("apple", f("lt", "banana"))).toBe(true);
        expect(matchesFilter("banana", f("lt", "apple"))).toBe(false);
      });

      it("covers a range inclusively", () => {
        expect(matchesFilter(5, f("between", "1", "10"))).toBe(true);
        expect(matchesFilter(1, f("between", "1", "10"))).toBe(true);
        expect(matchesFilter(10, f("between", "1", "10"))).toBe(true);
        expect(matchesFilter(11, f("between", "1", "10"))).toBe(false);
      });

      it("covers a date range", () => {
        expect(matchesFilter("2026-03-04", f("between", "2026-01-01", "2026-12-31"))).toBe(true);
        expect(matchesFilter("2025-12-31", f("between", "2026-01-01", "2026-12-31"))).toBe(false);
      });
    });
  });

  describe("isActiveFilter", () => {
    it("ignores a filter with nothing typed into it", () => {
      // Opening the menu should not empty the grid.
      expect(isActiveFilter(undefined)).toBe(false);
      expect(isActiveFilter(f("contains", ""))).toBe(false);
      expect(isActiveFilter(f("contains", "   "))).toBe(false);
    });

    it("counts the operators that take no operand", () => {
      expect(isActiveFilter(f("isNull"))).toBe(true);
      expect(isActiveFilter(f("isNotNull"))).toBe(true);
    });

    it("waits for both ends of a range", () => {
      expect(isActiveFilter(f("between", "1"))).toBe(false);
      expect(isActiveFilter(f("between", "1", "10"))).toBe(true);
    });
  });

  describe("describeFilter", () => {
    it("reads as a sentence", () => {
      expect(describeFilter("email", f("contains", "@example"))).toBe(
        "email contains @example",
      );
      expect(describeFilter("deleted_at", f("isNull"))).toBe("deleted_at is NULL");
      expect(describeFilter("age", f("between", "18", "65"))).toBe("age between 18 and 65");
    });
  });
});
