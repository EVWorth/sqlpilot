import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../stores/editorStore";
import { useResultStore } from "../../../stores/resultStore";
import { SQLEditor } from "../SQLEditor";

// Monaco reduced to the calls the marker effect makes, with the real stores.

const SCRIPT = "SELECT * FROM products;\nSELECT * FROM nope;\nSELECT 1;";
const setModelMarkers = vi.fn();
const model = { getValue: () => SCRIPT };
const monaco = {
  editor: { setModelMarkers, addKeybindingRule: vi.fn() },
  MarkerSeverity: { Error: 8 },
  languages: { registerCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })) },
};

vi.mock("@monaco-editor/react", async () => {
  const { useEffect } = await import("react");
  function MockEditor({ onMount }: { onMount?: (ed: unknown, m: unknown) => void }) {
    useEffect(() => {
      onMount?.({ getModel: () => model, addAction: vi.fn() }, monaco);
    }, [onMount]);
    return <div data-testid="monaco" />;
  }
  return { default: MockEditor, useMonaco: () => monaco };
});

vi.mock("../../../lib/schema-completion-provider", () => ({
  createCompletionProvider: vi.fn(() => ({})),
}));

vi.mock("../../../hooks/useSchemaCompletion", () => ({
  useSchemaCompletion: () => ({ connectionId: null }),
}));

vi.mock("../../../lib/tauri-api", () => ({ api: {}, CommandError: class extends Error {} }));

beforeEach(() => {
  setModelMarkers.mockClear();
  useEditorStore.setState({
    tabs: [{ id: "tab-a", title: "A", content: SCRIPT, type: "query", isDirty: false }],
    activeTabId: "tab-a",
  });
  useResultStore.setState({ error: null, failedStatement: null });
});

describe("the statement a script failed at is marked (#845)", () => {
  it("puts an error marker on that statement", () => {
    render(<SQLEditor />);
    act(() => {
      useResultStore.setState({
        error: "Table 'shop.nope' doesn't exist",
        failedStatement: { index: 1, count: 3, sql: "SELECT * FROM nope", code: 1146 },
      });
    });

    const [, owner, markers] = setModelMarkers.mock.calls.at(-1) ?? [];
    expect(owner).toBe("sqlpilot-run");
    expect(markers).toEqual([
      expect.objectContaining({
        startLineNumber: 2,
        endLineNumber: 2,
        severity: 8,
        message: "Table 'shop.nope' doesn't exist",
        code: "1146",
      }),
    ]);
  });

  it("clears the marker when the next run starts", () => {
    useResultStore.setState({
      error: "x",
      failedStatement: { index: 1, count: 3, sql: "SELECT * FROM nope", code: null },
    });
    render(<SQLEditor />);
    act(() => {
      useResultStore.setState({ error: null, failedStatement: null });
    });

    expect(setModelMarkers.mock.calls.at(-1)?.[2]).toEqual([]);
  });
});
