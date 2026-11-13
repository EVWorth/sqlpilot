import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeSource } from "../../lib/__tests__/fake-row-source";
import { createArraySource, type RowSource } from "../../lib/row-source";
import type { QueryResult } from "../../types";
import { useRowSelection } from "../useRowSelection";

// Rows: index 0 "cy", 1 "ada", 2 "bob", 3 "dee". Sorted by name the screen
// reads 1, 2, 0, 3.
const result = {
  columns: [
    { name: "id", data_type: "int", nullable: false, is_primary_key: true },
    { name: "name", data_type: "varchar", nullable: true, is_primary_key: false },
  ],
  rows: [[1, "cy"], [2, "ada"], [3, "bob"], [4, "dee"]],
} as unknown as QueryResult;

const byName = [{ column: 1, descending: false }];
const gridRef = { current: null };
const click = (init: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
  ({ shiftKey: false, ctrlKey: false, metaKey: false, ...init }) as React.MouseEvent;

function setup(source: RowSource) {
  const { result: hook } = renderHook(() => useRowSelection(source, "layout", gridRef));
  const picked = () => [...hook.current.selection.rows].sort((a, b) => a - b);
  return { hook, picked };
}

describe("useRowSelection", () => {
  it("picks a row on a plain click at once, without asking the source", () => {
    const source = createFakeSource(result, { held: true });
    const { hook, picked } = setup(source);

    act(() => hook.current.clickRow(click(), 2));

    expect(picked()).toEqual([2]);
    expect(source.asked).toEqual([]);
  });

  it("extends a Shift range over the rows between on screen, not in the result (#839)", async () => {
    const source = createArraySource(result);
    source.setView(byName, []);
    const { hook, picked } = setup(source);

    act(() => hook.current.clickRow(click(), 1));
    await act(async () => hook.current.clickRow(click({ shiftKey: true }), 0));

    // ada, bob, cy on screen: indices 1, 2, 0. Not 0..1, the result's run.
    expect(picked()).toEqual([0, 1, 2]);
    expect(hook.current.selection.anchor).toBe(1);
  });

  it("waits for the source before extending", async () => {
    const source = createFakeSource(result, { held: true });
    const { hook, picked } = setup(source);
    act(() => hook.current.clickRow(click(), 0));

    await act(async () => hook.current.clickRow(click({ shiftKey: true }), 2));
    expect(picked()).toEqual([0]);

    await act(async () => source.release());
    expect(picked()).toEqual([0, 1, 2]);
  });

  it("falls back to the result's order when a row of the range is filtered out", async () => {
    const source = createArraySource(result);
    // Hides index 0 ("cy"), the anchor.
    source.setView([], [{ column: 1, operator: "notEquals", value: "cy" }]);
    const { hook, picked } = setup(source);
    act(() => hook.current.clickRow(click(), 0));

    await act(async () => hook.current.clickRow(click({ shiftKey: true }), 2));

    expect(picked()).toEqual([0, 1, 2]);
  });

  it("steps through the view from the keyboard, and resolves to the row reached (#852)", async () => {
    const source = createArraySource(result);
    source.setView(byName, []);
    const { hook, picked } = setup(source);

    let reached: number | undefined;
    await act(async () => {
      reached = await hook.current.step(1, false);
    });
    expect(reached).toBe(1);
    expect(picked()).toEqual([1]);

    await act(async () => {
      reached = await hook.current.step(1, true);
    });
    expect(reached).toBe(2);
    expect(picked()).toEqual([1, 2]);

    await act(async () => {
      reached = await hook.current.step(Infinity, false);
    });
    expect(reached).toBe(3);
    expect(picked()).toEqual([3]);

    await act(async () => {
      reached = await hook.current.step(-Infinity, true);
    });
    expect(reached).toBe(1);
    // From the anchor (dee, last) back to the top: every row on screen.
    expect(picked()).toEqual([0, 1, 2, 3]);
  });

  it("starts a step up from nothing at the bottom, and a step down at the top", async () => {
    const source = createArraySource(result);
    source.setView(byName, []);
    const { hook, picked } = setup(source);

    await act(async () => void (await hook.current.step(-1, false)));
    expect(picked()).toEqual([3]);

    act(() => hook.current.clear());
    await act(async () => void (await hook.current.step(10, false)));
    expect(picked()).toEqual([1]);
  });

  it("clamps a step at the ends of the view", async () => {
    const source = createArraySource(result);
    const { hook, picked } = setup(source);
    act(() => hook.current.clickRow(click(), 2));

    await act(async () => void (await hook.current.step(10, false)));
    expect(picked()).toEqual([3]);
    await act(async () => void (await hook.current.step(-10, false)));
    expect(picked()).toEqual([0]);
  });

  it("runs steps pressed while the source is busy one after another, each from where the last landed", async () => {
    const source = createFakeSource(result, { held: true });
    const { hook, picked } = setup(source);
    act(() => hook.current.clickRow(click(), 0));

    let first: Promise<number | undefined> = Promise.resolve(undefined);
    let second: Promise<number | undefined> = Promise.resolve(undefined);
    act(() => {
      first = hook.current.step(1, false);
      second = hook.current.step(1, false);
    });
    expect(picked()).toEqual([0]);

    await act(async () => source.release());
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(picked()).toEqual([2]);
  });

  it("does nothing on a step through an empty view", async () => {
    const source = createArraySource(result);
    source.setView([], [{ column: 1, operator: "equals", value: "nobody" }]);
    const { hook, picked } = setup(source);

    let reached: number | undefined = 99;
    await act(async () => {
      reached = await hook.current.step(1, false);
    });
    expect(reached).toBeUndefined();
    expect(picked()).toEqual([]);
  });

  it("clears when the result changes", () => {
    const source = createArraySource(result);
    const { result: hook, rerender } = renderHook(({ key }) => useRowSelection(source, key, gridRef), {
      initialProps: { key: "a" },
    });
    act(() => hook.current.clickRow(click(), 1));
    expect(hook.current.selection.rows.size).toBe(1);

    rerender({ key: "b" });
    expect(hook.current.selection.rows.size).toBe(0);
  });
});
