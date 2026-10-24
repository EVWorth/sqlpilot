import { createElement, useCallback, useState } from "react";
import { ContextMenu, type MenuItem } from "../components/common/ContextMenu";

interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * Where to put the menu.
 *
 * At the pointer for a right-click. A menu opened from the keyboard (Shift+F10
 * or the context-menu key) can arrive with no pointer position, which put it
 * in the window's top-left corner; it goes under the element instead (#823).
 */
function anchor(e: React.MouseEvent): { x: number; y: number } {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const el = e.currentTarget instanceof Element ? e.currentTarget : e.target;
  if (!(el instanceof Element)) return { x: 0, y: 0 };
  const rect = el.getBoundingClientRect();
  return { x: rect.left + 16, y: rect.bottom };
}

export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState | null>(null);

  const showContextMenu = useCallback(
    (e: React.MouseEvent, items: MenuItem[]) => {
      e.preventDefault();
      e.stopPropagation();
      setState({ ...anchor(e), items });
    },
    [],
  );

  /** Open at a point, for a menu asked for from the keyboard (Shift+F10, the Menu key). */
  const showContextMenuAt = useCallback((x: number, y: number, items: MenuItem[]) => {
    setState({ x, y, items });
  }, []);

  const hideContextMenu = useCallback(() => {
    setState(null);
  }, []);

  const contextMenu = state
    ? createElement(ContextMenu, {
      x: state.x,
      y: state.y,
      items: state.items,
      onClose: hideContextMenu,
    })
    : null;

  return { contextMenu, showContextMenu, showContextMenuAt, hideContextMenu };
}
