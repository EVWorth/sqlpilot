import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { clampWidth, loadWidth, maxWidth, MIN_WIDTH, saveWidth } from "../lib/agent-panel-width";

/** How far one arrow key moves the divider. */
const STEP = 16;

/**
 * The agent panel's width, and the props for the divider that changes it.
 *
 * The panel sits on the right, so dragging the divider left widens it. The
 * divider is a focusable `separator` with its value, so the arrow keys work
 * too, and the width is kept inside the window as the window resizes.
 */
export function useAgentPanelWidth() {
  const [width, setWidth] = useState(() => loadWidth(window.innerWidth));
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const fit = () => setWidth((current) => clampWidth(current, window.innerWidth));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const resizeTo = useCallback((next: number, save: boolean) => {
    const fitted = clampWidth(next, window.innerWidth);
    setWidth(fitted);
    if (save) saveWidth(fitted);
  }, []);

  const separatorProps = {
    role: "separator",
    tabIndex: 0,
    "aria-label": "Resize the agent panel",
    "aria-orientation": "vertical" as const,
    "aria-valuenow": width,
    "aria-valuemin": MIN_WIDTH,
    "aria-valuemax": maxWidth(window.innerWidth),
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startWidth: width };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      resizeTo(drag.current.startWidth + (drag.current.startX - e.clientX), false);
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      resizeTo(drag.current.startWidth + (drag.current.startX - e.clientX), true);
      drag.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      const delta = e.key === "ArrowLeft" ? STEP : e.key === "ArrowRight" ? -STEP : 0;
      if (delta === 0) return;
      e.preventDefault();
      resizeTo(width + delta, true);
    },
  };

  return { width, separatorProps };
}
