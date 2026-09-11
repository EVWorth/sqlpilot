import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useColumnFilters } from "../useColumnFilters";

describe("useColumnFilters", () => {
  it("starts with nothing narrowing the grid", () => {
    const { result } = renderHook(() => useColumnFilters("k"));
    expect(result.current.active).toEqual([]);
  });

  it("keeps a half-written filter without applying it", () => {
    // Opening a menu and picking an operator should not empty the grid before
    // an operand is typed (#391).
    const { result } = renderHook(() => useColumnFilters("k"));

    act(() => result.current.set("name", { operator: "contains", value: "" }));

    expect(result.current.filters.name).toEqual({ operator: "contains", value: "" });
    expect(result.current.active).toEqual([]);
  });

  it("applies one once it has an operand", () => {
    const { result } = renderHook(() => useColumnFilters("k"));

    act(() => result.current.set("name", { operator: "contains", value: "al" }));

    expect(result.current.active).toEqual([
      { id: "name", value: { operator: "contains", value: "al" } },
    ]);
  });

  it("applies an operator that needs no operand straight away", () => {
    const { result } = renderHook(() => useColumnFilters("k"));

    act(() => result.current.set("deleted_at", { operator: "isNull", value: "" }));

    expect(result.current.active).toHaveLength(1);
  });

  it("removes one", () => {
    const { result } = renderHook(() => useColumnFilters("k"));
    act(() => result.current.set("name", { operator: "contains", value: "al" }));

    act(() => result.current.set("name", undefined));

    expect(result.current.filters.name).toBeUndefined();
    expect(result.current.active).toEqual([]);
  });

  it("clears every filter at once", () => {
    const { result } = renderHook(() => useColumnFilters("k"));
    act(() => {
      result.current.set("a", { operator: "contains", value: "x" });
      result.current.set("b", { operator: "contains", value: "y" });
    });

    act(() => result.current.clear());

    expect(result.current.active).toEqual([]);
  });

  it("forgets everything when the result changes", () => {
    // A filter is about the rows on screen, and means nothing once a
    // different query's have replaced them.
    const { result, rerender } = renderHook(({ key }) => useColumnFilters(key), {
      initialProps: { key: "first" },
    });
    act(() => result.current.set("name", { operator: "contains", value: "al" }));

    rerender({ key: "second" });

    expect(result.current.active).toEqual([]);
  });

  it("describes what is narrowing the grid", () => {
    const { result } = renderHook(() => useColumnFilters("k"));
    act(() => {
      result.current.set("name", { operator: "contains", value: "al" });
      result.current.set("deleted_at", { operator: "isNull", value: "" });
    });

    expect(result.current.describe()).toBe("name contains al; deleted_at is NULL");
  });
});
