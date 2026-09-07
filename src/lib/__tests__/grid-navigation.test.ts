import { describe, expect, it } from "vitest";
import { nextEditableCell } from "../grid-navigation";

const at = (rowIndex: number, colIndex: number) => ({ rowIndex, colIndex });

describe("nextEditableCell", () => {
  it("moves along the row", () => {
    expect(nextEditableCell(at(0, 0), false, 3, 3)).toEqual(at(0, 1));
  });

  it("moves back along the row on shift", () => {
    expect(nextEditableCell(at(0, 2), true, 3, 3)).toEqual(at(0, 1));
  });

  it("carries on into the next row past the last column", () => {
    expect(nextEditableCell(at(0, 2), false, 3, 3)).toEqual(at(1, 0));
  });

  it("carries back into the previous row before the first column", () => {
    expect(nextEditableCell(at(1, 0), true, 3, 3)).toEqual(at(0, 2));
  });

  it("stops at the end of the grid rather than wrapping to the top", () => {
    // Wrapping would move the edit somewhere the user is not looking.
    expect(nextEditableCell(at(2, 2), false, 3, 3)).toBeNull();
  });

  it("stops at the start of the grid", () => {
    expect(nextEditableCell(at(0, 0), true, 3, 3)).toBeNull();
  });

  it("has nowhere to go in an empty grid", () => {
    expect(nextEditableCell(at(0, 0), false, 0, 0)).toBeNull();
    expect(nextEditableCell(at(0, 0), false, 3, 0)).toBeNull();
  });

  it("handles a single cell", () => {
    expect(nextEditableCell(at(0, 0), false, 1, 1)).toBeNull();
    expect(nextEditableCell(at(0, 0), true, 1, 1)).toBeNull();
  });
});
