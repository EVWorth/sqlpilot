import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "../../../hooks/useKeyboardShortcuts";
import { useEditorStore } from "../../../stores/editorStore";
import { SQLEditor } from "../SQLEditor";

// The real editor store and keyboard shortcuts, with Monaco reduced to a
// textarea that reports changes the way it does: through onChange, which the
// editor writes to the store only after a 150 ms debounce.

vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea
      aria-label="SQL"
      defaultValue={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
  useMonaco: () => null,
}));

vi.mock("../../../lib/schema-completion-provider", () => ({
  createCompletionProvider: vi.fn(() => ({})),
}));

vi.mock("../../../hooks/useSchemaCompletion", () => ({
  useSchemaCompletion: () => ({ connectionId: null }),
}));

vi.mock("../../../lib/tauri-api", () => ({ api: {} }));

function Harness() {
  useKeyboardShortcuts();
  return <SQLEditor />;
}

beforeEach(() => {
  useEditorStore.setState({
    tabs: [
      { id: "tab-a", title: "A", content: "", type: "query", isDirty: false },
      { id: "tab-b", title: "B", content: "", type: "query", isDirty: false },
    ],
    activeTabId: "tab-a",
    pendingClose: null,
  });
});

describe("Ctrl+W right after typing (#861)", () => {
  it("asks before closing, rather than reading the store's stale empty content", () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      fireEvent.change(screen.getByLabelText("SQL"), { target: { value: "DELETE FROM t" } });

      // Well inside the debounce.
      act(() => {
        vi.advanceTimersByTime(20);
      });
      fireEvent.keyDown(screen.getByLabelText("SQL"), { key: "w", ctrlKey: true });

      const { tabs, pendingClose } = useEditorStore.getState();
      expect(tabs.map((t) => t.id)).toContain("tab-a");
      expect(pendingClose?.atRisk.map((t) => t.content)).toEqual(["DELETE FROM t"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
