import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../../components/common/ContextMenu";

vi.mock("../../components/common/ContextMenu", () => ({
  ContextMenu: vi.fn(() => null),
}));

import { useContextMenu } from "../useContextMenu";

beforeEach(() => {
  vi.clearAllMocks();
});

function createMockMouseEvent(
  clientX: number,
  clientY: number,
): React.MouseEvent {
  const event = new MouseEvent("contextmenu", {
    clientX,
    clientY,
    bubbles: true,
    cancelable: true,
  }) as unknown as React.MouseEvent;
  return event;
}

const mockItems: MenuItem[] = [
  { label: "Copy", onClick: vi.fn() },
  { label: "Paste", onClick: vi.fn() },
];

describe("useContextMenu", () => {
  it("returns null for contextMenu when no context menu is shown", () => {
    const { result } = renderHook(() => useContextMenu());
    expect(result.current.contextMenu).toBeNull();
  });

  it("showContextMenu sets state so contextMenu is a React element", () => {
    const { result } = renderHook(() => useContextMenu());

    act(() => {
      result.current.showContextMenu(
        createMockMouseEvent(100, 200),
        mockItems,
      );
    });

    expect(result.current.contextMenu).not.toBeNull();
    // React element has $$typeof and type
    expect(typeof result.current.contextMenu).toBe("object");
    expect(result.current.contextMenu).toHaveProperty("$$typeof");
  });

  it("contextMenu element contains x, y, items, and onClose props", () => {
    const { result } = renderHook(() => useContextMenu());

    act(() => {
      result.current.showContextMenu(
        createMockMouseEvent(50, 75),
        mockItems,
      );
    });

    const el = result.current.contextMenu as { props: Record<string, unknown> };
    expect(el.props.x).toBe(50);
    expect(el.props.y).toBe(75);
    expect(el.props.items).toBe(mockItems);
    expect(typeof el.props.onClose).toBe("function");
  });

  it("hideContextMenu nullifies state and returns contextMenu to null", () => {
    const { result } = renderHook(() => useContextMenu());

    act(() => {
      result.current.showContextMenu(
        createMockMouseEvent(10, 20),
        mockItems,
      );
    });

    expect(result.current.contextMenu).not.toBeNull();

    act(() => {
      result.current.hideContextMenu();
    });

    expect(result.current.contextMenu).toBeNull();
  });

  it("showContextMenu calls preventDefault and stopPropagation on the event", () => {
    const { result } = renderHook(() => useContextMenu());
    const event = createMockMouseEvent(300, 400);
    const spyPrevent = vi.spyOn(event, "preventDefault");
    const spyStop = vi.spyOn(event, "stopPropagation");

    act(() => {
      result.current.showContextMenu(event, mockItems);
    });

    expect(spyPrevent).toHaveBeenCalledTimes(1);
    expect(spyStop).toHaveBeenCalledTimes(1);
  });

  it("passes onClose handler that calls hideContextMenu when clicked", () => {
    const { result } = renderHook(() => useContextMenu());

    act(() => {
      result.current.showContextMenu(
        createMockMouseEvent(100, 100),
        mockItems,
      );
    });

    const el = result.current.contextMenu as { props: Record<string, unknown> };
    const onCloseHandler = el.props.onClose as () => void;

    act(() => {
      onCloseHandler();
    });

    expect(result.current.contextMenu).toBeNull();
  });
});
