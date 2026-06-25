import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../ConfirmDialog";

describe("ConfirmDialog", () => {
  it("renders nothing when isOpen is false", () => {
    const { container } = render(
      <ConfirmDialog
        isOpen={false}
        title="Test Title"
        message="Test Message"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders title and message when isOpen is true", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Delete Item"
        message="Are you sure you want to delete this item?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Delete Item")).toBeInTheDocument();
    expect(
      screen.getByText("Are you sure you want to delete this item?"),
    ).toBeInTheDocument();
  });

  it("renders custom button labels", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test"
        message="Test"
        confirmLabel="Yes, delete"
        cancelLabel="Never mind"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Yes, delete")).toBeInTheDocument();
    expect(screen.getByText("Never mind")).toBeInTheDocument();
  });

  it("uses default button labels when not provided", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test"
        message="Test"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Confirm")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test"
        message="Test"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test"
        message="Test"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders warning icon when danger is true", () => {
    const { container } = render(
      <ConfirmDialog
        isOpen={true}
        title="Test"
        message="Test"
        danger={true}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("does not render warning icon when danger is false", () => {
    const { container } = render(
      <ConfirmDialog
        isOpen={true}
        title="Test"
        message="Test"
        danger={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const svg = container.querySelector("svg.lucide-alert-triangle");
    expect(svg).toBeNull();
  });
});
