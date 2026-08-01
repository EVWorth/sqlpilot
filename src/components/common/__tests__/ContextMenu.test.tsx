import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, type MenuItem } from "../ContextMenu";

describe("ContextMenu", () => {
  const createItems = (overrides: Partial<Record<string, Partial<MenuItem>>> = {}): MenuItem[] => [
    { label: "Copy", onClick: vi.fn(), ...overrides.copy },
    { label: "Paste", onClick: vi.fn(), ...overrides.paste },
    { label: "Separator", onClick: vi.fn(), separator: true, ...overrides.separator },
    { label: "Delete", onClick: vi.fn(), danger: true, ...overrides.delete },
  ];

  it("renders at the given x/y position", () => {
    render(
      <ContextMenu x={100} y={200} items={createItems()} onClose={vi.fn()} />,
    );
    const menu = document.querySelector("[style*='left']") as HTMLElement;
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("200px");
  });

  it("renders non-separator menu items", () => {
    render(
      <ContextMenu x={0} y={0} items={createItems()} onClose={vi.fn()} />,
    );
    expect(screen.getByText("Copy")).toBeInTheDocument();
    expect(screen.getByText("Paste")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("renders separator items as horizontal rules (not buttons)", () => {
    render(
      <ContextMenu x={0} y={0} items={createItems()} onClose={vi.fn()} />,
    );
    // "Separator" text should NOT appear as a button since separator items are divs
    expect(screen.queryByText("Separator")).not.toBeInTheDocument();
  });

  it("calls item onClick and onClose when a menu item is clicked", () => {
    const onCopy = vi.fn();
    const onClose = vi.fn();
    const items: MenuItem[] = [
      { label: "Copy", onClick: onCopy },
    ];

    render(<ContextMenu x={0} y={0} items={items} onClose={onClose} />);

    fireEvent.click(screen.getByText("Copy"));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables item when disabled is true", () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    const items: MenuItem[] = [
      { label: "Disabled Item", onClick, disabled: true },
    ];

    render(<ContextMenu x={0} y={0} items={items} onClose={onClose} />);

    fireEvent.click(screen.getByText("Disabled Item"));
    expect(onClick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when clicking outside the menu", () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <ContextMenu x={0} y={0} items={createItems()} onClose={onClose} />
      </div>,
    );

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu x={0} y={0} items={createItems()} onClose={onClose} />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on scroll (any ancestor — menu is anchored to x/y)", () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="scrollable" style={{ overflow: "auto" }}>
          <ContextMenu x={0} y={0} items={createItems()} onClose={onClose} />
        </div>
      </div>,
    );

    // Use capture phase since the scroll listener is registered with `{capture: true}`
    const scrollable = screen.getByTestId("scrollable");
    fireEvent.scroll(scrollable, { target: { scrollTop: 10 } });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on window resize", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu x={0} y={0} items={createItems()} onClose={onClose} />,
    );

    fireEvent.resize(window);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when document becomes hidden", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu x={0} y={0} items={createItems()} onClose={onClose} />,
    );

    // visibilitychange handler only closes when state becomes "hidden"
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onClose when document becomes visible (only hidden triggers close)", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu x={0} y={0} items={createItems()} onClose={onClose} />,
    );

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders icons when provided", () => {
    const items: MenuItem[] = [
      { label: "With Icon", icon: <span data-testid="menu-icon">*</span>, onClick: vi.fn() },
    ];

    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);

    expect(screen.getByTestId("menu-icon")).toBeInTheDocument();
  });
});
