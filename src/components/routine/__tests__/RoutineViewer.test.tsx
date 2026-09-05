import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineViewer } from "../RoutineViewer";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    getRoutineDdl: vi.fn(),
    executeQuery: vi.fn(),
  },
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({ value, language, options }: { value: string; language: string; options: Record<string, unknown> }) => (
    <div data-testid="monaco-editor" data-value={value} data-language={language}>
      {options?.readOnly ? "(readonly)" : "(editable)"}
    </div>
  ),
}));

vi.mock("../../../stores/editorStore", () => ({
  useEditorStore: {
    getState: vi.fn(),
  },
}));

vi.mock("../../../stores/resultStore", () => ({
  useResultStore: {
    getState: vi.fn(),
  },
}));

import { api } from "../../../lib/tauri-api";
import { useEditorStore } from "../../../stores/editorStore";
import { useResultStore } from "../../../stores/resultStore";

const mockDdl = `CREATE PROCEDURE test_sp(
  IN p_id INT,
  OUT p_name VARCHAR(255)
)
BEGIN
  SELECT name INTO p_name FROM users WHERE id = p_id;
END`;

describe("RoutineViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getRoutineDdl).mockResolvedValue(mockDdl);
    vi.mocked(useEditorStore.getState).mockReturnValue({
      addTab: vi.fn(() => "new-tab"),
      updateTabContent: vi.fn(),
      tabs: [],
      closeTab: vi.fn(),
    });
    vi.mocked(useResultStore.getState).mockReturnValue({
      executeQuery: vi.fn().mockResolvedValue(undefined),
      error: null,
      confirmDialog: null,
    } as never);
  });

  it("shows loading state", async () => {
    vi.mocked(api.getRoutineDdl).mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <RoutineViewer connectionId="conn-1" database="testdb" routineName="test_sp" routineType="PROCEDURE" />,
    );
    // The loader icon should be in the DOM
    expect(container.querySelector("svg")).toBeDefined();
  });

  it("renders routine name and type after loading", async () => {
    render(
      <RoutineViewer connectionId="conn-1" database="testdb" routineName="test_sp" routineType="PROCEDURE" />,
    );
    expect(await screen.findByText("test_sp")).toBeDefined();
    expect(screen.getByText("PROCEDURE")).toBeDefined();
  });

  it("shows DDL in Monaco editor", async () => {
    render(
      <RoutineViewer connectionId="conn-1" database="testdb" routineName="test_sp" routineType="PROCEDURE" />,
    );
    expect(await screen.findByTestId("monaco-editor")).toBeDefined();
  });

  it("shows parameter inputs for PROCEDURE", async () => {
    render(
      <RoutineViewer connectionId="conn-1" database="testdb" routineName="test_sp" routineType="PROCEDURE" />,
    );
    expect(await screen.findByText("Parameters")).toBeDefined();
    expect(screen.getByPlaceholderText("Enter p_id...")).toBeDefined();
    expect(screen.getByPlaceholderText(/(output)/)).toBeDefined();
  });

  it("shows retry button on error", async () => {
    vi.mocked(api.getRoutineDdl).mockRejectedValue("DDL not found");
    render(
      <RoutineViewer connectionId="conn-1" database="testdb" routineName="bad_sp" routineType="PROCEDURE" />,
    );
    expect(await screen.findByText("DDL not found")).toBeDefined();
    expect(screen.getByText("Retry")).toBeDefined();
  });

  it("calls loadDdl again on retry click", async () => {
    vi.mocked(api.getRoutineDdl).mockRejectedValue("DDL not found");
    render(
      <RoutineViewer connectionId="conn-1" database="testdb" routineName="bad_sp" routineType="PROCEDURE" />,
    );
    expect(await screen.findByText("Retry")).toBeDefined();
    fireEvent.click(screen.getByText("Retry"));
    expect(api.getRoutineDdl).toHaveBeenCalledTimes(2);
  });

  it("toggles DDL section visibility", async () => {
    render(
      <RoutineViewer connectionId="conn-1" database="testdb" routineName="test_sp" routineType="PROCEDURE" />,
    );
    await screen.findByText("test_sp");

    const ddlButton = screen.getByText("DDL Definition");
    fireEvent.click(ddlButton);

    // After collapsing, the editor should be hidden
    expect(screen.queryByTestId("monaco-editor")).toBeNull();

    fireEvent.click(screen.getByText("DDL Definition"));
    expect(screen.getByTestId("monaco-editor")).toBeDefined();
  });

  it("has Edit, Execute, and Drop buttons", async () => {
    render(
      <RoutineViewer connectionId="conn-1" database="testdb" routineName="test_sp" routineType="PROCEDURE" />,
    );
    await screen.findByText("test_sp");
    expect(screen.getByText("Execute")).toBeDefined();
    expect(screen.getByText("Edit")).toBeDefined();
  });

  it("renders FUNCTION type with correct icon text", async () => {
    const funcDdl = "CREATE FUNCTION add_one(x INT) RETURNS INT RETURN x + 1";
    vi.mocked(api.getRoutineDdl).mockResolvedValue(funcDdl);

    render(
      <RoutineViewer connectionId="conn-1" database="testdb" routineName="add_one" routineType="FUNCTION" />,
    );
    expect(await screen.findByText("add_one")).toBeDefined();
    expect(screen.getByText("FUNCTION")).toBeDefined();
  });

  it("copies DDL to editor tab on Edit click", async () => {
    const mockAddTab = vi.fn(() => "new-tab");
    const mockUpdateTabContent = vi.fn();
    vi.mocked(useEditorStore.getState).mockReturnValue({
      addTab: mockAddTab,
      updateTabContent: mockUpdateTabContent,
      tabs: [],
      closeTab: vi.fn(),
    });

    render(
      <RoutineViewer connectionId="conn-1" database="testdb" routineName="test_sp" routineType="PROCEDURE" />,
    );

    await screen.findByText("test_sp");
    fireEvent.click(screen.getByText("Edit"));
    expect(mockAddTab).toHaveBeenCalledWith("conn-1", "testdb");
    expect(mockUpdateTabContent).toHaveBeenCalledWith("new-tab", mockDdl);
  });
});

describe("dropping a routine", () => {
  beforeEach(() => {
    vi.mocked(api.getRoutineDdl).mockResolvedValue(mockDdl);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  async function renderAndDrop(name = "test_sp") {
    await act(async () => {
      render(
        <RoutineViewer connectionId="conn-1" database="testdb" routineName={name} routineType="PROCEDURE" />,
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(/drop/i));
    });
  }

  it("goes through the store, so the production gate applies", async () => {
    // It called api.executeQuery directly, which skips the store's
    // production-safety check entirely — so dropping a routine on a
    // production connection was one unstyled browser prompt away (#393).
    await renderAndDrop();

    expect(useResultStore.getState().executeQuery).toHaveBeenCalledWith(
      "conn-1",
      "DROP PROCEDURE `testdb`.`test_sp`",
      "testdb",
    );
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("quotes a name containing a backtick instead of ending the quoting", async () => {
    await renderAndDrop("we`ird");

    expect(useResultStore.getState().executeQuery).toHaveBeenCalledWith(
      "conn-1",
      "DROP PROCEDURE `testdb`.`we``ird`",
      "testdb",
    );
  });

  it("leaves the tab open while the production dialog is waiting", async () => {
    const closeTab = vi.fn();
    vi.mocked(useEditorStore.getState).mockReturnValue({
      addTab: vi.fn(),
      updateTabContent: vi.fn(),
      tabs: [{ id: "t1", type: "routine", routineName: "test_sp", database: "testdb" }],
      closeTab,
    } as never);
    vi.mocked(useResultStore.getState).mockReturnValue({
      executeQuery: vi.fn().mockResolvedValue(undefined),
      error: null,
      confirmDialog: { isOpen: true, kind: "query", connectionId: "conn-1", sql: "DROP ..." },
    } as never);

    await renderAndDrop();

    // Closing it now would take away what the dialog is asking about.
    expect(closeTab).not.toHaveBeenCalled();
  });
});
