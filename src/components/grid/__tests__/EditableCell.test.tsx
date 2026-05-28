import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditableCell } from "../EditableCell";
import type { SqlValue } from "../../../types";

function createDefaultProps(overrides = {}) {
  return {
    value: null as SqlValue,
    dataType: "varchar",
    isEdited: false,
    onCommit: vi.fn(),
    onTab: vi.fn(),
    ...overrides,
  };
}

describe("EditableCell", () => {
  it("renders NULL for null value in display mode", () => {
    const { container } = render(<EditableCell {...createDefaultProps({ value: null })} />);
    expect(container.textContent).toContain("NULL");
  });

  it("renders string value in display mode", () => {
    const { container } = render(<EditableCell {...createDefaultProps({ value: "hello" })} />);
    expect(container.textContent).toContain("hello");
  });

  it("renders number value in display mode", () => {
    const { container } = render(<EditableCell {...createDefaultProps({ value: 42, dataType: "int" })} />);
    expect(container.textContent).toContain("42");
  });

  it("renders boolean checkbox for boolean type", () => {
    render(<EditableCell {...createDefaultProps({ value: true, dataType: "bool" })} />);
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toBeChecked();
  });

  it("toggles boolean value on checkbox change", () => {
    const onCommit = vi.fn();
    render(<EditableCell {...createDefaultProps({ value: true, dataType: "bool", onCommit })} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onCommit).toHaveBeenCalledWith(0);
  });

  it("toggles boolean value from 0 to 1", () => {
    const onCommit = vi.fn();
    render(<EditableCell {...createDefaultProps({ value: 0, dataType: "tinyint(1)", onCommit })} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onCommit).toHaveBeenCalledWith(1);
  });

  it("enters edit mode on double click", () => {
    const { container } = render(<EditableCell {...createDefaultProps({ value: "click me" })} />);
    fireEvent.doubleClick(container.firstElementChild!);
    const input = screen.getByRole("textbox");
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("click me");
  });

  it("shows empty string in edit mode for null value", () => {
    const { container } = render(<EditableCell {...createDefaultProps({ value: null })} />);
    fireEvent.doubleClick(container.firstElementChild!);
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("");
  });

  it("commits value on Enter key", () => {
    const onCommit = vi.fn();
    const { container } = render(<EditableCell {...createDefaultProps({ value: "old", onCommit })} />);
    fireEvent.doubleClick(container.firstElementChild!);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new value" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("new value");
  });

  it("commits value on Tab key", () => {
    const onCommit = vi.fn();
    const onTab = vi.fn();
    const { container } = render(<EditableCell {...createDefaultProps({ value: "old", onCommit, onTab })} />);
    fireEvent.doubleClick(container.firstElementChild!);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "tabbed" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onCommit).toHaveBeenCalledWith("tabbed");
    expect(onTab).toHaveBeenCalledWith(false);
  });

  it("commits value on Tab with shift", () => {
    const onCommit = vi.fn();
    const onTab = vi.fn();
    const { container } = render(<EditableCell {...createDefaultProps({ value: "old", onCommit, onTab })} />);
    fireEvent.doubleClick(container.firstElementChild!);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "shift-tab" } });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(onTab).toHaveBeenCalledWith(true);
  });

  it("cancels edit mode on Escape", () => {
    const onCommit = vi.fn();
    const { container } = render(<EditableCell {...createDefaultProps({ value: "old", onCommit })} />);
    fireEvent.doubleClick(container.firstElementChild!);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "cancel" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("commits on blur", () => {
    const onCommit = vi.fn();
    const { container } = render(<EditableCell {...createDefaultProps({ value: "old", onCommit })} />);
    fireEvent.doubleClick(container.firstElementChild!);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "blur value" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("blur value");
  });

  it("parses numeric values for numeric types", () => {
    const onCommit = vi.fn();
    const { container } = render(<EditableCell {...createDefaultProps({ value: null, dataType: "int", onCommit })} />);
    fireEvent.doubleClick(container.firstElementChild!);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "123" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(123);
  });

  it("uses textarea for long text types", () => {
    const { container } = render(<EditableCell {...createDefaultProps({ value: "text content", dataType: "text" })} />);
    fireEvent.doubleClick(container.firstElementChild!);
    expect(document.querySelector("textarea")).toBeInTheDocument();
  });

  it("uses number input for numeric types", () => {
    const { container } = render(<EditableCell {...createDefaultProps({ value: null, dataType: "int" })} />);
    fireEvent.doubleClick(container.firstElementChild!);
    const input = screen.getByRole("spinbutton");
    expect(input).toHaveAttribute("type", "number");
  });

  it("toggles null in edit mode via null button", () => {
    const onCommit = vi.fn();
    const { container } = render(<EditableCell {...createDefaultProps({ value: null, onCommit })} />);
    // Enter edit mode for a non-null type
    fireEvent.doubleClick(container.firstElementChild!);
    // In edit mode, find the ∅ button (title won't help as it renders ∅ character)
    const editButtons = container.querySelectorAll("button");
    const nullBtn = Array.from(editButtons).find(
      (b) => b.getAttribute("title") === "Set value",
    );
    expect(nullBtn).toBeTruthy();
    if (nullBtn) {
      fireEvent.mouseDown(nullBtn);
      expect(onCommit).toHaveBeenCalledWith("");
    }
  });

  it("toggles non-null value to NULL in edit mode", () => {
    const onCommit = vi.fn();
    const { container } = render(<EditableCell {...createDefaultProps({ value: "exists", onCommit })} />);
    fireEvent.doubleClick(container.firstElementChild!);
    const editButtons = container.querySelectorAll("button");
    const nullBtn = Array.from(editButtons).find(
      (b) => b.getAttribute("title") === "Set NULL",
    );
    expect(nullBtn).toBeTruthy();
    if (nullBtn) {
      fireEvent.mouseDown(nullBtn);
      expect(onCommit).toHaveBeenCalledWith(null);
    }
  });

  it("shows edited indicator when isEdited is true", () => {
    const { container } = render(<EditableCell {...createDefaultProps({ value: "edited", isEdited: true })} />);
    expect(container.firstElementChild).toHaveClass("border-l-2", "border-amber-400");
  });
});
