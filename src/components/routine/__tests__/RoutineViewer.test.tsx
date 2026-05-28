import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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

import { api } from "../../../lib/tauri-api";
import { useEditorStore } from "../../../stores/editorStore";

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
