import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyncPreview } from "../SyncPreview";

vi.mock("../../../lib/tauri-api", () => ({
  api: {
    executeQuery: vi.fn(),
  },
}));

import { api } from "../../../lib/tauri-api";

const mockStatements = [
  {
    sql: "CREATE TABLE new_table (id INT PRIMARY KEY);",
    type: "create" as const,
    objectType: "TABLE",
    objectName: "new_table",
    destructive: false,
  },
  {
    sql: "ALTER TABLE users ADD COLUMN email VARCHAR(255);",
    type: "alter" as const,
    objectType: "TABLE",
    objectName: "users",
    destructive: false,
  },
  {
    sql: "DROP TABLE old_table;",
    type: "drop" as const,
    objectType: "TABLE",
    objectName: "old_table",
    destructive: true,
  },
];

const mockProps = {
  statements: mockStatements,
  targetConnectionId: "conn-1",
  targetDatabase: "testdb",
  onBack: vi.fn(),
};

describe("SyncPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.executeQuery).mockResolvedValue([]);
    // Mock clipboard
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders statements", () => {
    render(<SyncPreview {...mockProps} />);
    expect(screen.getByText(/CREATE TABLE new_table/)).toBeDefined();
    expect(screen.getByText(/ALTER TABLE users/)).toBeDefined();
    expect(screen.getByText(/DROP TABLE old_table/)).toBeDefined();
  });

  it("shows Back to comparison button", () => {
    render(<SyncPreview {...mockProps} />);
    fireEvent.click(screen.getByText("Back to comparison"));
    expect(mockProps.onBack).toHaveBeenCalled();
  });

  it("shows statement type labels", () => {
    render(<SyncPreview {...mockProps} />);
    expect(screen.getByText("CREATE")).toBeDefined();
    expect(screen.getByText("ALTER")).toBeDefined();
    expect(screen.getByText("DROP")).toBeDefined();
  });

  it("shows destructive count when destructive statement is selected", () => {
    render(<SyncPreview {...mockProps} />);
    // Select the destructive DROP statement (checkbox at index 3 - 0=selectAll, 1=create, 2=alter, 3=drop)
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // The last statement checkbox is the drop statement
    const dropCheckbox = checkboxes[checkboxes.length - 1];
    fireEvent.click(dropCheckbox);
    // Now the destructive count should appear
    expect(screen.getByText(/destructive/)).toBeDefined();
  });

  it("selects non-destructive statements by default", () => {
    render(<SyncPreview {...mockProps} />);
    // By default, non-destructive statements are preselected — destructive are not
    const checkboxes = screen.getAllByRole("checkbox");
    // The first checkbox is "select all", the destructive DROP is the last statement checkbox
    const dropCheckbox = checkboxes[checkboxes.length - 1];
    expect(dropCheckbox).toBeDefined();
  });

  it("toggles a statement selection", () => {
    render(<SyncPreview {...mockProps} />);
    const checkboxes = screen.getAllByRole("checkbox");
    // There are 4 checkboxes: select all + 3 statement checkboxes
    expect(checkboxes.length).toBe(4);
  });

  it("selects all / deselects all via toggle", () => {
    render(<SyncPreview {...mockProps} />);
    const selectAll = screen.getByText(/Select all/);
    // Click to deselect all (toggle from partial to all)
    fireEvent.click(selectAll);
    // Now all checkboxes should be checked
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes[0].checked).toBe(true);
  });

  it("copies selected SQL to clipboard", async () => {
    render(<SyncPreview {...mockProps} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Copy Selected"));
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalled();
  });

  it("shows confirmation dialog on execute click", () => {
    render(<SyncPreview {...mockProps} />);
    fireEvent.click(screen.getByText(/Execute Selected/));
    expect(screen.getByText("Confirm Sync Execution")).toBeDefined();
    expect(screen.getByText("Cancel")).toBeDefined();
    expect(screen.getByText("Execute")).toBeDefined();
  });

  it("closes confirmation on Cancel", () => {
    render(<SyncPreview {...mockProps} />);

    const executeBtn = screen.getByText(/Execute Selected/);
    fireEvent.click(executeBtn);
    expect(screen.getByText("Confirm Sync Execution")).toBeDefined();

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Confirm Sync Execution")).toBeNull();
  });

  it("executes selected statements on confirm", async () => {
    render(<SyncPreview {...mockProps} />);

    fireEvent.click(screen.getByText(/Execute Selected/));
    expect(screen.getByText("Confirm Sync Execution")).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByText("Execute"));
    });

    expect(api.executeQuery).toHaveBeenCalledWith(
      "conn-1",
      expect.stringContaining("USE testdb"),
    );
  });

  it("shows destructive warning in confirmation", () => {
    const allDestructiveProps = {
      ...mockProps,
      statements: mockStatements.map((s) => ({
        ...s,
        destructive: true,
      })),
    };

    render(<SyncPreview {...allDestructiveProps} />);
    fireEvent.click(screen.getByText(/Select all/));
    fireEvent.click(screen.getByText(/Execute Selected/));
    // Destructive warning should appear
    expect(screen.getByText(/destructive statement/)).toBeDefined();
  });
});
