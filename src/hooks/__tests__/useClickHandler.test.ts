import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useClickHandler } from "../useClickHandler";

const DOUBLE_CLICK_DELAY_MS = 250;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useClickHandler", () => {
  it("fires onSingle after DOUBLE_CLICK_DELAY_MS on a single click", () => {
    const onSingle = vi.fn();
    const onDouble = vi.fn();

    const { result } = renderHook(() => useClickHandler());
    const handler = result.current("key-1", onSingle, onDouble);

    act(() => {
      handler();
    });

    expect(onSingle).not.toHaveBeenCalled();
    expect(onDouble).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(DOUBLE_CLICK_DELAY_MS);
    });

    expect(onSingle).toHaveBeenCalledTimes(1);
    expect(onDouble).not.toHaveBeenCalled();
  });

  it("fires onDouble and cancels onSingle on a double click", () => {
    const onSingle = vi.fn();
    const onDouble = vi.fn();

    const { result } = renderHook(() => useClickHandler());
    const handler = result.current("key-1", onSingle, onDouble);

    act(() => {
      handler();
    });

    act(() => {
      vi.advanceTimersByTime(100);
      handler();
    });

    expect(onDouble).toHaveBeenCalledTimes(1);
    expect(onSingle).not.toHaveBeenCalled();
  });

  it("fires onSingle after delay then another single click fires again after delay", () => {
    const onSingle = vi.fn();
    const onDouble = vi.fn();

    const { result } = renderHook(() => useClickHandler());
    const handler = result.current("key-1", onSingle, onDouble);

    // First click -> single
    act(() => {
      handler();
    });
    act(() => {
      vi.advanceTimersByTime(DOUBLE_CLICK_DELAY_MS);
    });
    expect(onSingle).toHaveBeenCalledTimes(1);

    // Second click (after clear) -> single again
    act(() => {
      handler();
    });
    act(() => {
      vi.advanceTimersByTime(DOUBLE_CLICK_DELAY_MS);
    });
    expect(onSingle).toHaveBeenCalledTimes(2);
    expect(onDouble).not.toHaveBeenCalled();
  });

  it("tracks multiple keys independently", () => {
    const onSingle1 = vi.fn();
    const onDouble1 = vi.fn();
    const onSingle2 = vi.fn();
    const onDouble2 = vi.fn();

    const { result } = renderHook(() => useClickHandler());
    const handler1 = result.current("row-1", onSingle1, onDouble1);
    const handler2 = result.current("row-2", onSingle2, onDouble2);

    // Click row-1 once
    act(() => {
      handler1();
    });

    // Click row-2 twice quickly
    act(() => {
      handler2();
    });
    act(() => {
      vi.advanceTimersByTime(100);
      handler2();
    });

    // row-2 double fires immediately
    expect(onDouble2).toHaveBeenCalledTimes(1);
    expect(onSingle2).not.toHaveBeenCalled();

    // row-1 timer still pending
    expect(onSingle1).not.toHaveBeenCalled();

    // Advance past row-1 timer
    act(() => {
      vi.advanceTimersByTime(DOUBLE_CLICK_DELAY_MS);
    });

    expect(onSingle1).toHaveBeenCalledTimes(1);
    expect(onDouble1).not.toHaveBeenCalled();
  });

  it("returns a new handler reference each time makeClickHandler is called", () => {
    const { result } = renderHook(() => useClickHandler());
    const handler1 = result.current("a", vi.fn(), vi.fn());
    const handler2 = result.current("b", vi.fn(), vi.fn());

    expect(handler1).not.toBe(handler2);
  });

  it("clears timer properly after onDouble so subsequent clicks behave as singles", () => {
    const onSingle = vi.fn();
    const onDouble = vi.fn();

    const { result } = renderHook(() => useClickHandler());
    const handler = result.current("key-1", onSingle, onDouble);

    // Double click
    act(() => {
      handler();
    });
    act(() => {
      vi.advanceTimersByTime(100);
      handler();
    });
    expect(onDouble).toHaveBeenCalledTimes(1);

    // Now single click
    act(() => {
      handler();
    });
    act(() => {
      vi.advanceTimersByTime(DOUBLE_CLICK_DELAY_MS);
    });
    expect(onSingle).toHaveBeenCalledTimes(1);
    // onDouble should not fire again
    expect(onDouble).toHaveBeenCalledTimes(1);
  });
});
