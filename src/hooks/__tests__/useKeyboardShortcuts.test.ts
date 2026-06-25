import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "../useKeyboardShortcuts";

const mockExecuteQuery = vi.fn().mockResolvedValue(undefined);
const mockSetActiveTab = vi.fn();
const mockAddTab = vi.fn();
const mockCloseTab = vi.fn();

vi.mock("../../stores/editorStore", () => ({
  useEditorStore: {
    getState: vi.fn(),
  },
}));

vi.mock("../../stores/resultStore", () => ({
  useResultStore: {
    getState: vi.fn(),
  },
}));

vi.mock("../../stores/connectionStore", () => ({
  useConnectionStore: {
    getState: vi.fn(),
  },
}));

import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";

const getEditorState = useEditorStore.getState as unknown as ReturnType<
  typeof vi.fn
>;
const getResultState = useResultStore.getState as unknown as ReturnType<
  typeof vi.fn
>;
const getConnectionState = useConnectionStore.getState as unknown as ReturnType<
  typeof vi.fn
>;

/** Creates a KeyboardEvent whose target has a .closest() method (HTMLElement) */
function createKeyboardEvent(
  key: string,
  opts: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    targetClosest?: boolean;
    targetTagName?: string;
  } = {},
): KeyboardEvent {
  const {
    ctrlKey = false,
    metaKey = false,
    shiftKey = false,
    targetClosest = false,
    targetTagName = "DIV",
  } = opts;

  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey,
    metaKey,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });

  // Override target to be an HTMLElement-like object with closest()
  const fakeTarget = {
    tagName: targetTagName,
    closest: (_selector: string) => (targetClosest ? ({ tagName: targetTagName }) : null),
  } as unknown as EventTarget & HTMLElement;

  Object.defineProperty(event, "target", {
    value: fakeTarget,
    writable: false,
    configurable: true,
  });

  return event;
}

beforeEach(() => {
  vi.clearAllMocks();

  getEditorState.mockReturnValue({
    tabs: [{ id: "tab-0", content: "SELECT 1" }],
    activeTabId: "tab-0",
    setActiveTab: mockSetActiveTab,
    addTab: mockAddTab.mockReturnValue("tab-1"),
    closeTab: mockCloseTab,
  });

  getResultState.mockReturnValue({
    executeQuery: mockExecuteQuery,
  });

  getConnectionState.mockReturnValue({
    selectedConnectionId: "conn-1",
  });
});

afterEach(() => {
  // Clean up event listeners
});

describe("useKeyboardShortcuts", () => {
  describe("F1 — shortcuts help", () => {
    it("calls onShowShortcuts when F1 is pressed and monaco is not focused", () => {
      const onShowShortcuts = vi.fn();
      renderHook(() => useKeyboardShortcuts(undefined, onShowShortcuts));

      const event = createKeyboardEvent("F1");
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      window.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(onShowShortcuts).toHaveBeenCalled();
    });

    it("does nothing when F1 is pressed but monaco editor is focused", () => {
      const onShowShortcuts = vi.fn();
      renderHook(() => useKeyboardShortcuts(undefined, onShowShortcuts));

      const event = createKeyboardEvent("F1", {
        targetClosest: true,
        targetTagName: "TEXTAREA",
      });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      window.dispatchEvent(event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(onShowShortcuts).not.toHaveBeenCalled();
    });
  });

  describe("F5 — execute query", () => {
    it("executes query when F5 is pressed with active tab content and connection", () => {
      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("F5");
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      window.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(mockExecuteQuery).toHaveBeenCalledWith(
        "conn-1",
        "SELECT 1",
        undefined,
      );
    });

    it("does not execute when no active tab has content", () => {
      getEditorState.mockReturnValue({
        tabs: [],
        activeTabId: null,
      });

      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("F5");
      window.dispatchEvent(event);

      expect(mockExecuteQuery).not.toHaveBeenCalled();
    });

    it("does not execute when active tab content is empty", () => {
      getEditorState.mockReturnValue({
        tabs: [{ id: "tab-0", content: "" }],
        activeTabId: "tab-0",
      });

      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("F5");
      window.dispatchEvent(event);

      expect(mockExecuteQuery).not.toHaveBeenCalled();
    });

    it("does not execute when active tab content is only whitespace", () => {
      getEditorState.mockReturnValue({
        tabs: [{ id: "tab-0", content: "   \n  " }],
        activeTabId: "tab-0",
      });

      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("F5");
      window.dispatchEvent(event);

      expect(mockExecuteQuery).not.toHaveBeenCalled();
    });

    it("does not execute when no connection is selected", () => {
      getConnectionState.mockReturnValue({
        selectedConnectionId: null,
      });

      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("F5");
      window.dispatchEvent(event);

      expect(mockExecuteQuery).not.toHaveBeenCalled();
    });
  });

  describe("Ctrl+S — save favorite", () => {
    let monacoTextarea: HTMLTextAreaElement;

    beforeEach(() => {
      // Create a mock Monaco editor focus context for isMonacoFocused check
      const wrapper = document.createElement("div");
      wrapper.className = "monaco-editor";
      monacoTextarea = document.createElement("textarea");
      wrapper.appendChild(monacoTextarea);
      document.body.appendChild(wrapper);
    });

    afterEach(() => {
      document.body.innerHTML = "";
    });

    it("calls onSaveFavorite when Ctrl+S is pressed with Monaco focused", () => {
      const onSaveFavorite = vi.fn();
      renderHook(() => useKeyboardShortcuts(undefined, undefined, onSaveFavorite));

      const event = createKeyboardEvent("s", { ctrlKey: true });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      Object.defineProperty(event, "target", { value: monacoTextarea, writable: false });
      window.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(onSaveFavorite).toHaveBeenCalled();
    });

    it("calls onSaveFavorite when Cmd+S is pressed with Monaco focused", () => {
      const onSaveFavorite = vi.fn();
      renderHook(() => useKeyboardShortcuts(undefined, undefined, onSaveFavorite));

      const event = createKeyboardEvent("s", { metaKey: true });
      Object.defineProperty(event, "target", { value: monacoTextarea, writable: false });
      window.dispatchEvent(event);

      expect(onSaveFavorite).toHaveBeenCalled();
    });

    it("does not call onSaveFavorite when Ctrl+Shift+S is pressed", () => {
      const onSaveFavorite = vi.fn();
      renderHook(() => useKeyboardShortcuts(undefined, undefined, onSaveFavorite));

      const event = createKeyboardEvent("s", { ctrlKey: true, shiftKey: true });
      window.dispatchEvent(event);

      expect(onSaveFavorite).not.toHaveBeenCalled();
    });

    it("does not call onSaveFavorite when regular 's' is pressed", () => {
      const onSaveFavorite = vi.fn();
      renderHook(() => useKeyboardShortcuts(undefined, undefined, onSaveFavorite));

      const event = createKeyboardEvent("s");
      window.dispatchEvent(event);

      expect(onSaveFavorite).not.toHaveBeenCalled();
    });
  });

  describe("Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs", () => {
    it("Ctrl+Tab moves to next tab", () => {
      getEditorState.mockReturnValue({
        tabs: [
          { id: "tab-0", content: "" },
          { id: "tab-1", content: "" },
          { id: "tab-2", content: "" },
        ],
        activeTabId: "tab-0",
        setActiveTab: mockSetActiveTab,
      });

      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("Tab", { ctrlKey: true });
      window.dispatchEvent(event);

      expect(mockSetActiveTab).toHaveBeenCalledWith("tab-1");
    });

    it("Ctrl+Shift+Tab moves to previous tab", () => {
      getEditorState.mockReturnValue({
        tabs: [
          { id: "tab-0", content: "" },
          { id: "tab-1", content: "" },
          { id: "tab-2", content: "" },
        ],
        activeTabId: "tab-0",
        setActiveTab: mockSetActiveTab,
      });

      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("Tab", {
        ctrlKey: true,
        shiftKey: true,
      });
      window.dispatchEvent(event);

      expect(mockSetActiveTab).toHaveBeenCalledWith("tab-2");
    });

    it("does nothing when only one tab exists", () => {
      getEditorState.mockReturnValue({
        tabs: [{ id: "tab-0", content: "" }],
        activeTabId: "tab-0",
        setActiveTab: mockSetActiveTab,
      });

      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("Tab", { ctrlKey: true });
      window.dispatchEvent(event);

      expect(mockSetActiveTab).not.toHaveBeenCalled();
    });
  });

  describe("Ctrl+N / Ctrl+T — new tab", () => {
    it("Ctrl+N adds a new tab", () => {
      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("n", { ctrlKey: true });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      window.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(mockAddTab).toHaveBeenCalled();
    });

    it("Ctrl+T adds a new tab", () => {
      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("t", { ctrlKey: true });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      window.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(mockAddTab).toHaveBeenCalled();
    });

    it("Ctrl+Shift+N does not add a new tab", () => {
      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("n", {
        ctrlKey: true,
        shiftKey: true,
      });
      window.dispatchEvent(event);

      expect(mockAddTab).not.toHaveBeenCalled();
    });
  });

  describe("Ctrl+W — close active tab", () => {
    it("closes the active tab", () => {
      getEditorState.mockReturnValue({
        tabs: [
          { id: "tab-0", content: "" },
          { id: "tab-1", content: "" },
        ],
        activeTabId: "tab-0",
        addTab: mockAddTab,
        closeTab: mockCloseTab,
      });

      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("w", { ctrlKey: true });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      window.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(mockCloseTab).toHaveBeenCalledWith("tab-0");
    });

    it("does nothing when no active tab", () => {
      getEditorState.mockReturnValue({
        tabs: [],
        activeTabId: null,
        addTab: mockAddTab,
        closeTab: mockCloseTab,
      });

      renderHook(() => useKeyboardShortcuts());

      const event = createKeyboardEvent("w", { ctrlKey: true });
      window.dispatchEvent(event);

      expect(mockCloseTab).not.toHaveBeenCalled();
    });
  });

  describe("Ctrl+Shift+C — toggle sidebar", () => {
    it("calls onToggleSidebar when Ctrl+Shift+C is pressed", () => {
      const onToggleSidebar = vi.fn();
      renderHook(() => useKeyboardShortcuts(onToggleSidebar));

      const event = createKeyboardEvent("C", {
        ctrlKey: true,
        shiftKey: true,
      });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      window.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(onToggleSidebar).toHaveBeenCalled();
    });

    it("does not call onToggleSidebar with just Ctrl+C (no shift)", () => {
      const onToggleSidebar = vi.fn();
      renderHook(() => useKeyboardShortcuts(onToggleSidebar));

      const event = createKeyboardEvent("C", { ctrlKey: true });
      window.dispatchEvent(event);

      expect(onToggleSidebar).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("removes event listener on unmount", () => {
      const addEventListenerSpy = vi.spyOn(window, "addEventListener");
      const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");

      const { unmount } = renderHook(() => useKeyboardShortcuts());

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        "keydown",
        expect.any(Function),
      );

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "keydown",
        expect.any(Function),
      );

      addEventListenerSpy.mockRestore();
      removeEventListenerSpy.mockRestore();
    });
  });
});
