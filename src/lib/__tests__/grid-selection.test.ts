import { describe, expect, it } from "vitest";
import { describeSelection, NO_SELECTION, rowsToCopy, selectAll, type Selection, selectRow } from "../grid-selection";

const plain = { toggle: false, extend: false };
const ctrl = { toggle: true, extend: false };
const shift = { toggle: false, extend: true };
const ctrlShift = { toggle: true, extend: true };

const rows = (s: Selection) => [...s.rows].sort((a, b) => a - b);

describe("grid-selection (#416)", () => {
  describe("a plain click", () => {
    it("selects one row and drops everything else", () => {
      const s = selectRow({ rows: new Set([1, 2, 3]), anchor: 1 }, 5, plain);
      expect(rows(s)).toEqual([5]);
      expect(s.anchor).toBe(5);
    });

    it("clears the selection when it is the only row selected", () => {
      // Otherwise getting back to nothing selected needs a menu.
      expect(rows(selectRow({ rows: new Set([5]), anchor: 5 }, 5, plain))).toEqual([]);
    });

    it("keeps a click on one of several selected rows as a narrowing", () => {
      expect(rows(selectRow({ rows: new Set([4, 5]), anchor: 4 }, 5, plain))).toEqual([5]);
    });
  });

  describe("Ctrl+click", () => {
    it("adds a row without dropping the rest", () => {
      expect(rows(selectRow({ rows: new Set([1]), anchor: 1 }, 4, ctrl))).toEqual([1, 4]);
    });

    it("removes a row that was already selected", () => {
      expect(rows(selectRow({ rows: new Set([1, 4]), anchor: 1 }, 4, ctrl))).toEqual([1]);
    });

    it("moves the anchor even when it removed the row", () => {
      // The next Shift+click should extend from where the user last pointed.
      expect(selectRow({ rows: new Set([1, 4]), anchor: 1 }, 4, ctrl).anchor).toBe(4);
    });
  });

  describe("Shift+click", () => {
    it("selects the range from the anchor", () => {
      expect(rows(selectRow({ rows: new Set([2]), anchor: 2 }, 5, shift))).toEqual([2, 3, 4, 5]);
    });

    it("works upwards too", () => {
      expect(rows(selectRow({ rows: new Set([5]), anchor: 5 }, 2, shift))).toEqual([2, 3, 4, 5]);
    });

    it("replaces the range rather than growing it on a second shift-click", () => {
      // The anchor stays put, so moving the shift-click resizes one range
      // instead of leaving a trail of them.
      const first = selectRow({ rows: new Set([2]), anchor: 2 }, 8, shift);
      const second = selectRow(first, 4, shift);
      expect(rows(second)).toEqual([2, 3, 4]);
      expect(second.anchor).toBe(2);
    });

    it("falls back to a plain click when there is no anchor", () => {
      expect(rows(selectRow(NO_SELECTION, 3, shift))).toEqual([3]);
    });

    it("keeps what was already selected when Ctrl is held too", () => {
      // Two separate ranges.
      const s = selectRow({ rows: new Set([0, 1]), anchor: 5 }, 7, ctrlShift);
      expect(rows(s)).toEqual([0, 1, 5, 6, 7]);
    });
  });

  describe("selectAll", () => {
    it("takes every row", () => {
      expect(rows(selectAll(3))).toEqual([0, 1, 2]);
    });

    it("selects nothing when there is nothing", () => {
      expect(rows(selectAll(0))).toEqual([]);
    });
  });

  describe("rowsToCopy", () => {
    it("is everything when nothing is selected", () => {
      // "Copy" with nothing picked has always meant everything; making the
      // user select 4000 rows first would be worse than the old behaviour.
      expect(rowsToCopy(NO_SELECTION, 3)).toEqual([0, 1, 2]);
    });

    it("is the selection, in the result's own order", () => {
      expect(rowsToCopy({ rows: new Set([7, 1, 4]), anchor: 7 }, 10)).toEqual([1, 4, 7]);
    });
  });

  describe("describeSelection", () => {
    it("counts the selection when there is one", () => {
      expect(describeSelection({ rows: new Set([1, 2]), anchor: 1 }, 500)).toBe("2 rows");
      expect(describeSelection({ rows: new Set([1]), anchor: 1 }, 500)).toBe("1 row");
    });

    it("counts the whole result when there is not", () => {
      expect(describeSelection(NO_SELECTION, 4200)).toBe("4,200 rows");
    });
  });
});
