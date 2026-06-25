import { fireEvent, render, screen } from "@testing-library/react";
import { Table2 } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { FolderNode } from "../FolderNode";

describe("FolderNode", () => {
  it("renders the label", () => {
    render(
      <FolderNode
        label="Tables"
        icon={<Table2 data-testid="icon" />}
        isExpanded={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("Tables")).toBeInTheDocument();
  });

  it("shows ChevronRight when collapsed", () => {
    const { container } = render(
      <FolderNode
        label="Tables"
        icon={<Table2 data-testid="icon" />}
        isExpanded={false}
        onToggle={vi.fn()}
      />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("calls onToggle when clicked", () => {
    const onToggle = vi.fn();
    render(
      <FolderNode
        label="Tables"
        icon={<Table2 data-testid="icon" />}
        isExpanded={false}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByText("Tables"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("renders children when expanded", () => {
    render(
      <FolderNode
        label="Tables"
        icon={<Table2 data-testid="icon" />}
        isExpanded={true}
        onToggle={vi.fn()}
      >
        <div data-testid="child">Item 1</div>
      </FolderNode>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("hides children when collapsed", () => {
    const { queryByTestId } = render(
      <FolderNode
        label="Tables"
        icon={<Table2 data-testid="icon" />}
        isExpanded={false}
        onToggle={vi.fn()}
      >
        <div data-testid="child">Item 1</div>
      </FolderNode>,
    );
    expect(queryByTestId("child")).toBeNull();
  });

  it("shows loading spinner when loading", () => {
    render(
      <FolderNode
        label="Views"
        icon={<Table2 data-testid="icon" />}
        isExpanded={true}
        onToggle={vi.fn()}
        loading={true}
      >
        <div>Content</div>
      </FolderNode>,
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows children when not loading", () => {
    render(
      <FolderNode
        label="Views"
        icon={<Table2 data-testid="icon" />}
        isExpanded={true}
        onToggle={vi.fn()}
        loading={false}
      >
        <div data-testid="content">Content</div>
      </FolderNode>,
    );
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("renders count when provided", () => {
    render(
      <FolderNode
        label="Tables"
        icon={<Table2 data-testid="icon" />}
        isExpanded={false}
        onToggle={vi.fn()}
        count={42}
      />,
    );
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("does not render count when not provided", () => {
    const { container } = render(
      <FolderNode
        label="Tables"
        icon={<Table2 data-testid="icon" />}
        isExpanded={false}
        onToggle={vi.fn()}
      />,
    );
    expect(container.textContent).toBe("Tables");
  });

  it("calls onContextMenu when right-clicked", () => {
    const onContextMenu = vi.fn();
    render(
      <FolderNode
        label="Tables"
        icon={<Table2 data-testid="icon" />}
        isExpanded={false}
        onToggle={vi.fn()}
        onContextMenu={onContextMenu}
      />,
    );
    fireEvent.contextMenu(screen.getByText("Tables"));
    expect(onContextMenu).toHaveBeenCalledOnce();
  });
});
