import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiScale } from "../useUiScale";

describe("useUiScale (#837)", () => {
  afterEach(() => {
    act(() => useSettingsStore.getState().resetZoom());
  });

  it("sets nothing at 100%", () => {
    renderHook(() => useUiScale());
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
  });

  it("zooms the root and publishes the factor, and takes it off again", () => {
    renderHook(() => useUiScale());
    act(() => useSettingsStore.getState().zoom(1));
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.1");
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1.1");
    act(() => useSettingsStore.getState().resetZoom());
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
  });
});
