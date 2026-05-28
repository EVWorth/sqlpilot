import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SQLPreviewDialog } from "../SQLPreviewDialog";

describe("SQLPreviewDialog", () => {
  const mockOnClose = vi.fn();
  const mockOnExecute = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders dialog with SQL content", () => {
    render(
      <SQLPreviewDialog
        sql="CREATE TABLE users (id INT PRIMARY KEY);"
        onClose={mockOnClose}
        onExecute={mockOnExecute}
      />,
    );
    expect(screen.getByText("SQL Preview")).toBeDefined();
    expect(screen.getByText("CREATE TABLE users (id INT PRIMARY KEY);")).toBeDefined();
  });

  it("renders Copy, Execute, and Close buttons", () => {
    render(
      <SQLPreviewDialog
        sql="SELECT 1;"
        onClose={mockOnClose}
        onExecute={mockOnExecute}
      />,
    );
    expect(screen.getByText("Copy")).toBeDefined();
    expect(screen.getByText("Execute")).toBeDefined();
    expect(screen.getByText("Close")).toBeDefined();
  });

  it("calls onClose when overlay is clicked", () => {
    render(
      <SQLPreviewDialog
        sql="SELECT 1;"
        onClose={mockOnClose}
        onExecute={mockOnExecute}
      />,
    );
    const overlay = document.querySelector(".fixed.inset-0") as HTMLElement;
    if (overlay) fireEvent.click(overlay);
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("calls onClose when Close button is clicked", () => {
    render(
      <SQLPreviewDialog
        sql="SELECT 1;"
        onClose={mockOnClose}
        onExecute={mockOnExecute}
      />,
    );
    fireEvent.click(screen.getByText("Close"));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("calls onClose when X button is clicked", () => {
    render(
      <SQLPreviewDialog
        sql="SELECT 1;"
        onClose={mockOnClose}
        onExecute={mockOnExecute}
      />,
    );
    // The X button is a button without text
    const buttons = screen.getAllByRole("button");
    const xButton = buttons[0];
    fireEvent.click(xButton);
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("calls onExecute and onClose on Execute click", () => {
    render(
      <SQLPreviewDialog
        sql="SELECT 1;"
        onClose={mockOnClose}
        onExecute={mockOnExecute}
      />,
    );
    fireEvent.click(screen.getByText("Execute"));
    expect(mockOnExecute).toHaveBeenCalled();
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("copies SQL to clipboard and shows Copied feedback", async () => {
    render(
      <SQLPreviewDialog
        sql="SELECT 1;"
        onClose={mockOnClose}
        onExecute={mockOnExecute}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Copy"));
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("SELECT 1;");
    expect(screen.getByText("Copied")).toBeDefined();
  });

  it("closes on Escape key", () => {
    render(
      <SQLPreviewDialog
        sql="SELECT 1;"
        onClose={mockOnClose}
        onExecute={mockOnExecute}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("does not close on other key presses", () => {
    render(
      <SQLPreviewDialog
        sql="SELECT 1;"
        onClose={mockOnClose}
        onExecute={mockOnExecute}
      />,
    );

    fireEvent.keyDown(document, { key: "Enter" });
    expect(mockOnClose).not.toHaveBeenCalled();
  });
});
