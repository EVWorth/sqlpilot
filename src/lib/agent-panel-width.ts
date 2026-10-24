/**
 * How wide the agent panel is.
 *
 * It was a fixed 380px, which in a 1024px window left the editor about 510px
 * and clipped the query toolbar (#822). Now the user drags it, within limits
 * that keep both sides usable, and the width they chose is remembered.
 */

const KEY = "sqlpilot-agent-panel-width";

/** Narrower than this and tool rows and the composer stop fitting. */
export const MIN_WIDTH = 300;
/** The width it opens at when the window has room for it. */
export const PREFERRED_WIDTH = 380;

/** The widest the panel may be in a window this wide: never more than half. */
export function maxWidth(windowWidth: number): number {
  return Math.max(MIN_WIDTH, Math.floor(windowWidth / 2));
}

export function clampWidth(width: number, windowWidth: number): number {
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), maxWidth(windowWidth)));
}

/** 380px in a big window; less in a small one, so the editor keeps its room. */
export function defaultWidth(windowWidth: number): number {
  return clampWidth(Math.min(PREFERRED_WIDTH, windowWidth * 0.3), windowWidth);
}

/** The width the user last chose, or the default, fitted to this window. */
export function loadWidth(windowWidth: number): number {
  let stored = NaN;
  try {
    stored = Number(localStorage.getItem(KEY));
  } catch {
    // Storage can be unavailable; the default is a fine answer.
  }
  return Number.isFinite(stored) && stored > 0 ? clampWidth(stored, windowWidth) : defaultWidth(windowWidth);
}

export function saveWidth(width: number): void {
  try {
    localStorage.setItem(KEY, String(Math.round(width)));
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
}
