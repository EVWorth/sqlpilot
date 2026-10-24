import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, type MenuAction, type MenuItem } from "../ContextMenu";

describe("ContextMenu", () => {
  const createItems = (overrides: Partial<Record<string, Partial<MenuAction>>> = {}): MenuItem[] => [
    { label: "Copy", onClick: vi.fn(), ...overrides.copy },
    { label: "Paste", onClick: vi.fn(), ...overrides.paste },
    // A separator carries nothing: the union no longer lets it claim a label
    // or a handler it would never use (#336).
    { separator: true },
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

  it("renders a separator as a rule, not a button", () => {
    // Four items, one of them a separator: three things the user can reach.
    // Checking for the absence of a label the separator no longer has would
    // pass whatever the component did (#336).
    render(
      <ContextMenu x={0} y={0} items={createItems()} onClose={vi.fn()} />,
    );

    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("keeps a separator out of the tab order", () => {
    render(
      <ContextMenu x={0} y={0} items={[{ separator: true }]} onClose={vi.fn()} />,
    );

    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[tabindex]")).toHaveLength(0);
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

  describe("from the keyboard (#823)", () => {
    const keys = (key: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key });

    it("is a menu of menu items", () => {
      render(<ContextMenu x={0} y={0} items={createItems()} onClose={vi.fn()} />);

      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Copy", "Paste", "Delete"]);
    });

    it("focuses the first enabled item when it opens", () => {
      render(
        <ContextMenu x={0} y={0} items={createItems({ copy: { disabled: true } })} onClose={vi.fn()} />,
      );

      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Paste" }));
    });

    it("moves with Up, Down, Home and End, skipping separators and disabled items", () => {
      render(
        <ContextMenu x={0} y={0} items={createItems({ paste: { disabled: true } })} onClose={vi.fn()} />,
      );
      const focused = () => document.activeElement?.textContent;
      expect(focused()).toBe("Copy");

      keys("ArrowDown");
      expect(focused()).toBe("Delete");
      keys("ArrowDown");
      expect(focused()).toBe("Copy"); // wraps
      keys("ArrowUp");
      expect(focused()).toBe("Delete");
      keys("Home");
      expect(focused()).toBe("Copy");
      keys("End");
      expect(focused()).toBe("Delete");
    });

    it("runs the focused item on Enter", () => {
      const onPaste = vi.fn();
      const onClose = vi.fn();
      render(<ContextMenu x={0} y={0} items={createItems({ paste: { onClick: onPaste } })} onClose={onClose} />);

      keys("ArrowDown");
      // A button's Enter is a click; jsdom does not synthesise it.
      fireEvent.click(document.activeElement as HTMLElement);

      expect(onPaste).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("closes on Tab", () => {
      const onClose = vi.fn();
      render(<ContextMenu x={0} y={0} items={createItems()} onClose={onClose} />);

      keys("Tab");

      expect(onClose).toHaveBeenCalledOnce();
    });

    /** A row that opens the menu, as the tree and the grid do. */
    function Opener({ onPick }: { onPick?: () => void }) {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onContextMenu={() => setOpen(true)}>row</button>
          <input aria-label="elsewhere" />
          {open && (
            <ContextMenu
              x={0}
              y={0}
              items={[{ label: "Pick", onClick: onPick ?? vi.fn() }]}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    it("gives focus back to what opened it when it closes", () => {
      render(<Opener />);
      const row = screen.getByRole("button", { name: "row" });
      row.focus();

      fireEvent.contextMenu(row);
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Pick" }));

      act(() => {
        fireEvent.keyDown(document, { key: "Escape" });
      });

      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(row);
    });

    it("leaves focus where the chosen action put it", () => {
      render(<Opener onPick={() => screen.getByLabelText("elsewhere").focus()} />);
      const row = screen.getByRole("button", { name: "row" });
      row.focus();
      fireEvent.contextMenu(row);

      fireEvent.click(screen.getByRole("menuitem", { name: "Pick" }));

      expect(document.activeElement).toBe(screen.getByLabelText("elsewhere"));
    });
  });
});
