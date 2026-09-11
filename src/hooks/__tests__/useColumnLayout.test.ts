import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { layoutKey, readLayout } from "../../lib/grid-layout";
import type { ColumnMeta } from "../../types";
import { useColumnLayout } from "../useColumnLayout";

const columns = (...names: string[]): ColumnMeta[] =>
  names.map((name) => ({ name, data_type: "int", nullable: true, is_primary_key: false }));

/**
 * These exist because this used to be four `useMemo`s and an effect inside a
 * 1400-line component, reachable only by rendering the whole grid (#406).
 */
describe("useColumnLayout", () => {
  beforeEach(() => localStorage.clear());

  const render = (cols = columns("id", "name", "email")) => renderHook(() => useColumnLayout("c1", "shop", cols));

  it("starts in the order the query returned", () => {
    const { result } = render();
    expect(result.current.columnOrder).toEqual(["id", "name", "email"]);
    expect(result.current.isReordered).toBe(false);
  });

  it("moves a column and remembers it", () => {
    const { result } = render();

    act(() => result.current.moveColumn("email", "id"));

    expect(result.current.columnOrder).toEqual(["email", "id", "name"]);
    expect(result.current.isReordered).toBe(true);
    expect(readLayout(layoutKey("c1", "shop", ["id", "name", "email"]))?.columnOrder)
      .toEqual(["email", "id", "name"]);
  });

  it("restores a remembered order on the next result of the same shape", () => {
    localStorage.setItem(
      layoutKey("c1", "shop", ["id", "name", "email"])!,
      JSON.stringify({ columnOrder: ["email", "name", "id"] }),
    );

    const { result } = render();

    expect(result.current.columnOrder).toEqual(["email", "name", "id"]);
    expect(result.current.isReordered).toBe(true);
  });

  it("puts them back, and writes that down too", () => {
    const { result } = render();
    act(() => result.current.moveColumn("email", "id"));

    act(() => result.current.reset());

    expect(result.current.columnOrder).toEqual(["id", "name", "email"]);
    expect(result.current.isReordered).toBe(false);
    expect(readLayout(layoutKey("c1", "shop", ["id", "name", "email"]))?.columnOrder)
      .toEqual(["id", "name", "email"]);
  });

  it("reports the columns themselves in display order", () => {
    // Pending insert rows are laid out cell by cell from this, so a wrong
    // order here puts every value under the wrong header (#392).
    const { result } = render();

    act(() => result.current.moveColumn("email", "id"));

    expect(result.current.orderedColumns.map((c) => c.name)).toEqual(["email", "id", "name"]);
  });

  it("has no order and no key for an empty result", () => {
    const { result } = renderHook(() => useColumnLayout("c1", "shop", []));
    expect(result.current.columnOrder).toEqual([]);
    expect(result.current.layoutId).toBeNull();
  });

  it("survives a caller that builds its column list inline", () => {
    // A new array on every render, with an effect keyed on array identity,
    // resets the order, re-renders, and does it again forever. This hung the
    // test worker for eighty seconds before it was found.
    const { result } = renderHook(() => useColumnLayout("c1", "shop", columns("id", "name")));
    expect(result.current.columnOrder).toEqual(["id", "name"]);
  });

  it("keeps its own key per connection, so two servers do not share a layout", () => {
    const a = renderHook(() => useColumnLayout("c1", "shop", columns("id")));
    const b = renderHook(() => useColumnLayout("c2", "shop", columns("id")));
    expect(a.result.current.layoutId).not.toBe(b.result.current.layoutId);
  });
});
