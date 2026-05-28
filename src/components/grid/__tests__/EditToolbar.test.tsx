import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditToolbar } from "../EditToolbar";

function createDefaultProps(overrides = {}) {
  return {
    editMode: false,
    onToggleEditMode: vi.fn(),
    pendingCount: 0,
    hasChanges: false,
    hasPrimaryKey: true,
    isSaving: false,
    onAddRow: vi.fn(),
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  };
}

describe("EditToolbar", () => {
  it("renders Edit Mode button", () => {
    render(<EditToolbar {...createDefaultProps()} />);
    expect(screen.getByText("Edit Mode")).toBeInTheDocument();
  });

  it("calls onToggleEditMode when Edit Mode button is clicked", () => {
    const props = createDefaultProps();
    render(<EditToolbar {...props} />);
    fireEvent.click(screen.getByText("Edit Mode"));
    expect(props.onToggleEditMode).toHaveBeenCalledTimes(1);
  });

  it("renders Add Row button when editMode is true", () => {
    render(<EditToolbar {...createDefaultProps({ editMode: true })} />);
    expect(screen.getByText("Add Row")).toBeInTheDocument();
  });

  it("does not render Add Row when editMode is false", () => {
    render(<EditToolbar {...createDefaultProps({ editMode: false })} />);
    expect(screen.queryByText("Add Row")).not.toBeInTheDocument();
  });

  it("renders Save Changes when editMode is true", () => {
    render(<EditToolbar {...createDefaultProps({ editMode: true })} />);
    expect(screen.getByText(/Save Changes/)).toBeInTheDocument();
  });

  it("renders Discard button when editMode is true", () => {
    render(<EditToolbar {...createDefaultProps({ editMode: true })} />);
    expect(screen.getByText("Discard")).toBeInTheDocument();
  });

  it("shows pending count when hasChanges is true", () => {
    render(
      <EditToolbar {...createDefaultProps({ editMode: true, hasChanges: true, pendingCount: 3 })} />,
    );
    expect(screen.getByText("Save Changes (3)")).toBeInTheDocument();
  });

  it("calls onAddRow when Add Row is clicked", () => {
    const props = createDefaultProps({ editMode: true });
    render(<EditToolbar {...props} />);
    fireEvent.click(screen.getByText("Add Row"));
    expect(props.onAddRow).toHaveBeenCalledTimes(1);
  });

  it("calls onSave when Save Changes is clicked", () => {
    const props = createDefaultProps({ editMode: true, hasChanges: true });
    render(<EditToolbar {...props} />);
    fireEvent.click(screen.getByText(/Save Changes/));
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it("calls onDiscard when Discard is clicked", () => {
    const props = createDefaultProps({ editMode: true, hasChanges: true });
    render(<EditToolbar {...props} />);
    fireEvent.click(screen.getByText("Discard"));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
  });

  it("disables Save button when hasChanges is false", () => {
    render(<EditToolbar {...createDefaultProps({ editMode: true, hasChanges: false })} />);
    const saveBtn = screen.getByText(/Save Changes/);
    expect(saveBtn).toBeDisabled();
  });

  it("disables Save button when isSaving is true", () => {
    render(<EditToolbar {...createDefaultProps({ editMode: true, hasChanges: true, isSaving: true })} />);
    const saveBtn = screen.getByText(/Save Changes/);
    expect(saveBtn).toBeDisabled();
  });

  it("disables Discard when hasChanges is false", () => {
    render(<EditToolbar {...createDefaultProps({ editMode: true, hasChanges: false })} />);
    expect(screen.getByText("Discard")).toBeDisabled();
  });

  it("shows no primary key warning when hasPrimaryKey is false", () => {
    render(<EditToolbar {...createDefaultProps({ editMode: true, hasPrimaryKey: false })} />);
    expect(screen.getByText(/No primary key detected/)).toBeInTheDocument();
  });

  it("does not show no primary key warning when hasPrimaryKey is true", () => {
    render(<EditToolbar {...createDefaultProps({ editMode: true, hasPrimaryKey: true })} />);
    expect(screen.queryByText(/No primary key detected/)).not.toBeInTheDocument();
  });
});
