import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@monaco-editor/react", () => ({
  default: ({ value, options }: { value: string; options?: { readOnly?: boolean } }) => (
    <pre data-testid="monaco-editor" data-readonly={String(options?.readOnly ?? false)}>{value}</pre>
  ),
}));

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getTableDdl: vi.fn(),
    getViewDdl: vi.fn(),
    getTriggerDdl: vi.fn(),
    getRoutineDdl: vi.fn(),
  },
}));

import { api } from "../../../lib/tauri-api";
import { useDdlStore } from "../../../stores/ddlStore";
import { useEditorStore } from "../../../stores/editorStore";
import { DdlViewer } from "../DdlViewer";

const TABLE_DDL = "CREATE TABLE `customers` (\n  `id` int unsigned NOT NULL,\n  `email` varchar(255) NOT NULL\n)";

beforeEach(() => {
  vi.clearAllMocks();
  useDdlStore.setState({ entries: {} });
  useEditorStore.setState({ tabs: [], activeTabId: null });
  vi.mocked(api.getTableDdl).mockResolvedValue(TABLE_DDL);
  vi.mocked(api.getViewDdl).mockResolvedValue("CREATE VIEW v AS SELECT 1");
  vi.mocked(api.getTriggerDdl).mockResolvedValue("CREATE TRIGGER t BEFORE UPDATE ON o FOR EACH ROW SET @x = 1");
  vi.mocked(api.getRoutineDdl).mockResolvedValue("CREATE PROCEDURE p() BEGIN END");
});

describe("DdlViewer (#800)", () => {
  it("shows the whole DDL, read-only, from the schema API", async () => {
    render(<DdlViewer connectionId="c1" database="shop" objectName="customers" objectType="TABLE" />);

    const editor = await screen.findByTestId("monaco-editor");
    expect(editor.textContent).toBe(TABLE_DDL);
    expect(editor.dataset.readonly).toBe("true");
    expect(api.getTableDdl).toHaveBeenCalledWith("c1", "shop", "customers");
  });

  it.each(
    [
      ["VIEW", () => api.getViewDdl, ["c1", "shop", "obj"]],
      ["TRIGGER", () => api.getTriggerDdl, ["c1", "shop", "obj"]],
      ["PROCEDURE", () => api.getRoutineDdl, ["c1", "shop", "obj", "PROCEDURE"]],
      ["FUNCTION", () => api.getRoutineDdl, ["c1", "shop", "obj", "FUNCTION"]],
    ] as const,
  )("reads a %s through its own DDL command", async (objectType, fn, args) => {
    render(<DdlViewer connectionId="c1" database="shop" objectName="obj" objectType={objectType} />);
    await screen.findByTestId("monaco-editor");
    expect(fn()).toHaveBeenCalledWith(...args);
  });

  it("copies the DDL", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<DdlViewer connectionId="c1" database="shop" objectName="customers" objectType="TABLE" />);
    await screen.findByTestId("monaco-editor");

    await user.click(screen.getByRole("button", { name: /Copy/ }));

    expect(writeText).toHaveBeenCalledWith(TABLE_DDL);
  });

  it("opens the DDL in a new query tab", async () => {
    const user = userEvent.setup();
    render(<DdlViewer connectionId="c1" database="shop" objectName="customers" objectType="TABLE" />);
    await screen.findByTestId("monaco-editor");

    await user.click(screen.getByRole("button", { name: /Open in editor/ }));

    const { tabs } = useEditorStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ type: "query", connectionId: "c1", database: "shop", content: TABLE_DDL });
  });

  it("says why the DDL could not be read, and retries", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getTableDdl).mockRejectedValueOnce("access denied");
    render(<DdlViewer connectionId="c1" database="shop" objectName="customers" objectType="TABLE" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("access denied");
    expect(screen.getByRole("button", { name: /Copy/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByTestId("monaco-editor").textContent).toBe(TABLE_DDL));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
