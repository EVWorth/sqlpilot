import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGridEditing } from "../useGridEditing";
import type { SqlValue } from "../../types";

beforeEach(() => {
  // No special setup needed for this pure hook
});

describe("useGridEditing", () => {
  describe("initial state", () => {
    it("editMode is false by default", () => {
      const { result } = renderHook(() => useGridEditing());
      expect(result.current.editMode).toBe(false);
    });

    it("pendingCount is 0", () => {
      const { result } = renderHook(() => useGridEditing());
      expect(result.current.pendingCount).toBe(0);
    });

    it("hasChanges is false", () => {
      const { result } = renderHook(() => useGridEditing());
      expect(result.current.hasChanges).toBe(false);
    });

    it("inserts and deletes are empty", () => {
      const { result } = renderHook(() => useGridEditing());
      expect(result.current.inserts).toEqual([]);
      expect(result.current.deletes.size).toBe(0);
      expect(result.current.updates.size).toBe(0);
    });
  });

  describe("editCell", () => {
    it("adds a cell change", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "name", "old", "new");
      });

      expect(result.current.updates.size).toBe(1);
      const changes = result.current.updates.get(0);
      expect(changes).toEqual([
        { rowIndex: 0, column: "name", originalValue: "old", newValue: "new" },
      ]);
      expect(result.current.hasChanges).toBe(true);
    });

    it("updates an existing cell change", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "name", "old", "v1");
      });
      act(() => {
        result.current.editCell(0, "name", "old", "v2");
      });

      const changes = result.current.updates.get(0);
      expect(changes).toEqual([
        { rowIndex: 0, column: "name", originalValue: "old", newValue: "v2" },
      ]);
    });

    it("removes change when value matches original", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "name", "old", "new");
      });
      expect(result.current.updates.size).toBe(1);

      // Revert to original
      act(() => {
        result.current.editCell(0, "name", "old", "old");
      });
      expect(result.current.updates.size).toBe(0);
      expect(result.current.hasChanges).toBe(false);
    });

    it("tracks multiple columns in the same row", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "name", "old_name", "new_name");
      });
      act(() => {
        result.current.editCell(0, "age", 30, 31);
      });

      const changes = result.current.updates.get(0);
      expect(changes).toHaveLength(2);
      expect(changes?.[0].column).toBe("name");
      expect(changes?.[1].column).toBe("age");
    });

    it("tracks changes across multiple rows", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "name", "a", "b");
      });
      act(() => {
        result.current.editCell(1, "name", "x", "y");
      });

      expect(result.current.updates.size).toBe(2);
    });

    it("removes row key from updates when all cell changes are reverted", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "name", "old", "new");
      });
      act(() => {
        result.current.editCell(0, "name", "old", "old");
      });

      expect(result.current.updates.size).toBe(0);
      expect(result.current.hasChanges).toBe(false);
    });

    it("preserves other rows when one is reverted", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "col", "a", "b");
      });
      act(() => {
        result.current.editCell(1, "col", "x", "y");
      });
      act(() => {
        result.current.editCell(0, "col", "a", "a");
      });

      expect(result.current.updates.size).toBe(1);
      expect(result.current.updates.has(1)).toBe(true);
      expect(result.current.updates.has(0)).toBe(false);
    });
  });

  describe("revertCell", () => {
    it("removes a specific cell change", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "col1", "a", "b");
      });
      act(() => {
        result.current.editCell(0, "col2", "c", "d");
      });

      act(() => {
        result.current.revertCell(0, "col1");
      });

      const changes = result.current.updates.get(0);
      expect(changes).toHaveLength(1);
      expect(changes?.[0].column).toBe("col2");
    });

    it("removes row entry when all cells are reverted", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "col", "a", "b");
      });
      act(() => {
        result.current.revertCell(0, "col");
      });

      expect(result.current.updates.size).toBe(0);
    });

    it("does nothing for a non-existent cell", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.revertCell(0, "nonexistent");
      });

      expect(result.current.updates.size).toBe(0);
    });
  });

  describe("editInsertCell", () => {
    it("adds a value to an insert row", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.addRow();
      });
      act(() => {
        result.current.editInsertCell(0, "name", "Alice");
      });

      expect(result.current.inserts[0]).toEqual({ name: "Alice" });
    });

    it("updates an existing insert cell", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.addRow();
      });
      act(() => {
        result.current.editInsertCell(0, "name", "Alice");
      });
      act(() => {
        result.current.editInsertCell(0, "name", "Bob");
      });

      expect(result.current.inserts[0]).toEqual({ name: "Bob" });
    });

    it("adds multiple fields to an insert row", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.addRow();
      });
      act(() => {
        result.current.editInsertCell(0, "name", "Alice");
      });
      act(() => {
        result.current.editInsertCell(0, "age", "30");
      });

      expect(result.current.inserts[0]).toEqual({ name: "Alice", age: "30" });
    });
  });

  describe("addRow", () => {
    it("adds an empty insert row", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.addRow();
      });

      expect(result.current.inserts).toHaveLength(1);
      expect(result.current.inserts[0]).toEqual({});
      expect(result.current.hasChanges).toBe(true);
    });

    it("adds multiple insert rows", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.addRow();
      });
      act(() => {
        result.current.addRow();
      });

      expect(result.current.inserts).toHaveLength(2);
    });
  });

  describe("deleteRow", () => {
    it("adds a row index to deletes", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.deleteRow(5);
      });

      expect(result.current.deletes.has(5)).toBe(true);
      expect(result.current.hasChanges).toBe(true);
    });

    it("toggles a row index out of deletes when called again", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.deleteRow(5);
      });
      act(() => {
        result.current.deleteRow(5);
      });

      expect(result.current.deletes.has(5)).toBe(false);
    });

    it("tracks multiple deleted rows", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.deleteRow(1);
      });
      act(() => {
        result.current.deleteRow(3);
      });

      expect(result.current.deletes.has(1)).toBe(true);
      expect(result.current.deletes.has(3)).toBe(true);
      expect(result.current.deletes.size).toBe(2);
    });
  });

  describe("discardAll", () => {
    it("clears all updates, inserts, and deletes", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "col", "a", "b");
        result.current.addRow();
        result.current.deleteRow(1);
      });

      expect(result.current.hasChanges).toBe(true);

      act(() => {
        result.current.discardAll();
      });

      expect(result.current.updates.size).toBe(0);
      expect(result.current.inserts).toEqual([]);
      expect(result.current.deletes.size).toBe(0);
      expect(result.current.hasChanges).toBe(false);
    });
  });

  describe("toggleEditMode", () => {
    it("enters edit mode and does not discard", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.toggleEditMode();
      });

      expect(result.current.editMode).toBe(true);
    });

    it("exits edit mode and discards all changes", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.toggleEditMode(); // enter
      });
      act(() => {
        result.current.editCell(0, "col", "a", "b");
        result.current.addRow();
        result.current.deleteRow(5);
      });

      expect(result.current.hasChanges).toBe(true);

      act(() => {
        result.current.toggleEditMode(); // exit
      });

      expect(result.current.editMode).toBe(false);
      expect(result.current.updates.size).toBe(0);
      expect(result.current.inserts).toEqual([]);
      expect(result.current.deletes.size).toBe(0);
    });
  });

  describe("pendingCount", () => {
    it("returns sum of updates, inserts, and deletes", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "c1", "a", "b");
        result.current.editCell(1, "c1", "x", "y");
        result.current.addRow();
        result.current.addRow();
        result.current.deleteRow(3);
        result.current.deleteRow(5);
      });

      // 2 update rows + 2 inserts + 2 deletes = 6
      expect(result.current.pendingCount).toBe(6);
    });
  });

  describe("getCellValue", () => {
    it("returns original value when no changes exist for that cell", () => {
      const { result } = renderHook(() => useGridEditing());
      expect(result.current.getCellValue(0, "name", "original")).toBe(
        "original",
      );
    });

    it("returns new value when a change exists", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "name", "original", "modified");
      });

      expect(result.current.getCellValue(0, "name", "original")).toBe(
        "modified",
      );
    });

    it("returns original value for unchanged column in a row with other changes", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "name", "old_name", "new_name");
      });

      expect(result.current.getCellValue(0, "age", 30)).toBe(30);
    });
  });

  describe("isCellEdited", () => {
    it("returns false when cell is not edited", () => {
      const { result } = renderHook(() => useGridEditing());
      expect(result.current.isCellEdited(0, "name")).toBe(false);
    });

    it("returns true when cell is edited", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "name", "old", "new");
      });

      expect(result.current.isCellEdited(0, "name")).toBe(true);
    });

    it("returns false after cell change is reverted", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(0, "name", "old", "new");
      });
      act(() => {
        result.current.editCell(0, "name", "old", "old");
      });

      expect(result.current.isCellEdited(0, "name")).toBe(false);
    });
  });

  describe("isRowEdited", () => {
    it("returns false when row has no edits", () => {
      const { result } = renderHook(() => useGridEditing());
      expect(result.current.isRowEdited(0)).toBe(false);
    });

    it("returns true when row has edits", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.editCell(3, "col", "a", "b");
      });

      expect(result.current.isRowEdited(3)).toBe(true);
    });
  });

  describe("isRowDeleted", () => {
    it("returns false when row is not deleted", () => {
      const { result } = renderHook(() => useGridEditing());
      expect(result.current.isRowDeleted(0)).toBe(false);
    });

    it("returns true when row is deleted", () => {
      const { result } = renderHook(() => useGridEditing());

      act(() => {
        result.current.deleteRow(7);
      });

      expect(result.current.isRowDeleted(7)).toBe(true);
    });
  });
});
