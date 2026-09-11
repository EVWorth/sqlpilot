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

  it("applies the theme to Monaco when Monaco mounts after the change", () => {
    // Monaco loads asynchronously, so a theme chosen before it mounts has
    // nowhere to go at the time it is chosen (#351).
    const currentTheme = "light";
    let monaco: unknown = null;

    (useThemeStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (s: { effectiveTheme: string }) => string) => selector({ effectiveTheme: currentTheme }),
    );
    (useMonaco as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => monaco);

    const { rerender } = renderHook(() => useTheme());
    expect(mockSetTheme).not.toHaveBeenCalled();

    monaco = { editor: { setTheme: mockSetTheme } };
    rerender();

    expect(mockSetTheme).toHaveBeenCalledWith("vs");
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
