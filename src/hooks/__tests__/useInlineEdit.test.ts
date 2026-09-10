import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useInlineEdit } from "../useInlineEdit";

/** Commit that always succeeds. */
const ok = () => null;

describe("useInlineEdit (#340)", () => {
  it("starts with nothing being edited", () => {
    const { result } = renderHook(() => useInlineEdit());
    expect(result.current.editingId).toBeNull();
  });

  it("seeds the draft when editing starts", () => {
    const { result } = renderHook(() => useInlineEdit());

    act(() => result.current.start("a", "Original"));

    expect(result.current.editingId).toBe("a");
    expect(result.current.value).toBe("Original");
  });

  it("commits the trimmed draft", () => {
    const commit = vi.fn(ok);
    const { result } = renderHook(() => useInlineEdit());
    act(() => result.current.start("a", "Original"));

    act(() => result.current.setValue("  Renamed  "));
    act(() => result.current.confirm(commit));

    expect(commit).toHaveBeenCalledWith("a", "Renamed");
    expect(result.current.editingId).toBeNull();
  });

  it("does not commit after a cancel, even if a blur follows (#333)", () => {
    // Whether unmounting a focused input fires blur is a renderer detail, so
    // the cancel has to hold even when it does.
    const commit = vi.fn(ok);
    const { result } = renderHook(() => useInlineEdit());
    act(() => result.current.start("a", "Original"));

    act(() => result.current.setValue("Renamed"));
    act(() => result.current.cancel());
    act(() => result.current.confirm(commit));

    expect(commit).not.toHaveBeenCalled();
  });

  it("cancels rather than committing an empty draft", () => {
    const commit = vi.fn(ok);
    const { result } = renderHook(() => useInlineEdit());
    act(() => result.current.start("a", "Original"));

    act(() => result.current.setValue("   "));
    act(() => result.current.confirm(commit));

    expect(commit).not.toHaveBeenCalled();
    expect(result.current.editingId).toBeNull();
  });

  it("stays open and reports why when the commit is refused", () => {
    // Closing would read as a successful edit that silently did not happen.
    const { result } = renderHook(() => useInlineEdit());
    act(() => result.current.start("a", "Original"));

    act(() => result.current.setValue("Taken"));
    act(() => result.current.confirm(() => "That name is already used."));

    expect(result.current.editingId).toBe("a");
    expect(result.current.error).toBe("That name is already used.");
  });

  it("clears the error as soon as the draft changes", () => {
    const { result } = renderHook(() => useInlineEdit());
    act(() => result.current.start("a", "Original"));
    act(() => result.current.confirm(() => "Nope."));

    act(() => result.current.setValue("Something else"));

    expect(result.current.error).toBeNull();
  });

  it("starts clean after a cancel", () => {
    const commit = vi.fn(ok);
    const { result } = renderHook(() => useInlineEdit());
    act(() => result.current.start("a", "Original"));
    act(() => result.current.cancel());

    act(() => result.current.start("b", "Second"));
    act(() => result.current.setValue("Renamed"));
    act(() => result.current.confirm(commit));

    expect(commit).toHaveBeenCalledWith("b", "Renamed");
  });

  it("clears a previous refusal when a new edit starts", () => {
    const { result } = renderHook(() => useInlineEdit());
    act(() => result.current.start("a", "Original"));
    act(() => result.current.confirm(() => "Nope."));

    act(() => result.current.start("b", "Second"));

    expect(result.current.error).toBeNull();
  });

  it("does nothing when confirming with no edit in progress", () => {
    const commit = vi.fn(ok);
    const { result } = renderHook(() => useInlineEdit());

    act(() => result.current.confirm(commit));

    expect(commit).not.toHaveBeenCalled();
  });

  describe("allowEmpty", () => {
    it("commits an emptied field when the caller allows it", () => {
      // Clearing a description is the only way to remove one; treating that
      // as a cancel would make it impossible.
      const commit = vi.fn(ok);
      const { result } = renderHook(() => useInlineEdit({ allowEmpty: true }));
      act(() => result.current.start("a", "Some notes"));

      act(() => result.current.setValue("   "));
      act(() => result.current.confirm(commit));

      expect(commit).toHaveBeenCalledWith("a", "");
      expect(result.current.editingId).toBeNull();
    });

    it("still cancels an emptied field by default", () => {
      const commit = vi.fn(ok);
      const { result } = renderHook(() => useInlineEdit());
      act(() => result.current.start("a", "A name"));

      act(() => result.current.setValue(""));
      act(() => result.current.confirm(commit));

      expect(commit).not.toHaveBeenCalled();
    });

    it("still honours a cancel under allowEmpty", () => {
      const commit = vi.fn(ok);
      const { result } = renderHook(() => useInlineEdit({ allowEmpty: true }));
      act(() => result.current.start("a", "Some notes"));

      act(() => result.current.cancel());
      act(() => result.current.confirm(commit));

      expect(commit).not.toHaveBeenCalled();
    });
  });
});
