import { createElement, useCallback, useState } from "react";
import { ContextMenu, type MenuItem } from "../components/common/ContextMenu";

interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState | null>(null);

  const showContextMenu = useCallback(
    (e: React.MouseEvent, items: MenuItem[]) => {
      e.preventDefault();
      e.stopPropagation();
      setState({ x: e.clientX, y: e.clientY, items });
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
