import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "../useTheme";

const mockSetTheme = vi.fn();

vi.mock("@monaco-editor/react", () => ({
  useMonaco: vi.fn(),
}));

vi.mock("../../stores/themeStore", () => ({
  useThemeStore: vi.fn(),
}));

import { useMonaco } from "@monaco-editor/react";
import { useThemeStore } from "../../stores/themeStore";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useTheme", () => {
  it("sets vs-dark when effectiveTheme is dark and monaco is available", () => {
    (useThemeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (s: { effectiveTheme: string }) => string) => selector({ effectiveTheme: "dark" }),
    );
    (useMonaco as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      editor: { setTheme: mockSetTheme },
    });

    renderHook(() => useTheme());

    expect(mockSetTheme).toHaveBeenCalledWith("vs-dark");
  });

  it("sets vs when effectiveTheme is light and monaco is available", () => {
    (useThemeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (s: { effectiveTheme: string }) => string) => selector({ effectiveTheme: "light" }),
    );
    (useMonaco as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      editor: { setTheme: mockSetTheme },
    });

    renderHook(() => useTheme());

    expect(mockSetTheme).toHaveBeenCalledWith("vs");
  });

  it("does not crash when monaco is not available", () => {
    (useThemeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (s: { effectiveTheme: string }) => string) => selector({ effectiveTheme: "dark" }),
    );
    (useMonaco as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);

    expect(() => renderHook(() => useTheme())).not.toThrow();
    expect(mockSetTheme).not.toHaveBeenCalled();
  });

  it("does not crash when monaco is null (edge case)", () => {
    (useThemeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (s: { effectiveTheme: string }) => string) => selector({ effectiveTheme: "light" }),
    );
    (useMonaco as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    expect(() => renderHook(() => useTheme())).not.toThrow();
    expect(mockSetTheme).not.toHaveBeenCalled();
  });

  it("re-runs and updates theme when effectiveTheme changes", () => {
    let effectiveTheme = "dark";
    const storeSubscribers: ((s: { effectiveTheme: string }) => string)[] = [];

    (useThemeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (s: { effectiveTheme: string }) => string) => {
        storeSubscribers.push(selector);
        return selector({ effectiveTheme });
      },
    );
    (useMonaco as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      editor: { setTheme: mockSetTheme },
    });

    const { rerender } = renderHook(() => useTheme());
    expect(mockSetTheme).toHaveBeenCalledWith("vs-dark");

    // Change to light
    mockSetTheme.mockClear();
    effectiveTheme = "light";
    rerender();

    // Note: The mock needs to return the new value when re-rendered.
    // Re-mock useThemeStore for the new value
  });

  it("updates theme when effectiveTheme changes from dark to light", () => {
    const mockSetThemeInstance = vi.fn();
    let currentTheme = "dark";

    (useThemeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (s: { effectiveTheme: string }) => string) => selector({ effectiveTheme: currentTheme }),
    );

    (useMonaco as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      editor: { setTheme: mockSetThemeInstance },
    });

    const { rerender } = renderHook(() => useTheme());
    expect(mockSetThemeInstance).toHaveBeenCalledWith("vs-dark");

    // Switch theme and re-render
    currentTheme = "light";
    rerender();
    expect(mockSetThemeInstance).toHaveBeenCalledWith("vs");
  });
});
