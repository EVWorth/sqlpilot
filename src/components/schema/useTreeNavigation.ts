import { useLayoutEffect, useRef, useState } from "react";

/**
 * Keyboard movement for a tree whose rows are `role="treeitem"` elements.
 *
 * Only ArrowLeft and ArrowRight used to work, each on its own row, so the
 * only way from one node to the next was Tab, and every row was a tab stop
 * (#823). This is the roving-tabindex pattern from the WAI-ARIA tree: one row
 * is in the tab order at a time, and Up, Down, Home and End move between the
 * rows that are on screen. Right on an open node goes to its first child and
 * Left on a closed node or a leaf goes to its parent; opening and closing
 * stay with the row, which knows how.
 *
 * It reads the order from the DOM rather than from the data: a collapsed
 * node's children are not rendered, so the rendered rows are exactly the
 * visible ones, in the order they are shown, whatever the filter is doing.
 * Rows say where they are with `aria-level` and who they are with
 * `data-tree-key`.
 */
export function useTreeNavigation(firstKey: string | null) {
  const treeRef = useRef<HTMLDivElement>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const rows = (): HTMLElement[] => rowsIn(treeRef.current);

  // The row in the tab order went away (its parent closed, or the filter hid
  // it): fall back to the first row, so Tab can still reach the tree. What is
  // rendered changes without the key changing, so this watches the tree's
  // rows rather than running after every render, which the dependency check
  // had to be switched off for (#930). It also sees a row that a child
  // component removed without the tree itself rendering again.
  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (activeKey === null || !tree) return;
    const settle = () => {
      if (!rowsIn(tree).some((r) => r.dataset.treeKey === activeKey)) setActiveKey(null);
    };
    settle();
    const observer = new MutationObserver(settle);
    observer.observe(tree, { childList: true, subtree: true, attributeFilter: ["data-tree-key"] });
    return () => observer.disconnect();
  }, [activeKey]);

  const current = activeKey ?? firstKey;

  /** Props for a row: its key, and whether it is the one Tab lands on. */
  const rowProps = (key: string) => ({
    "data-tree-key": key,
    tabIndex: key === current ? 0 : -1,
  });

  const moveTo = (row: HTMLElement | undefined) => {
    if (!row) return;
    row.focus();
    setActiveKey(row.dataset.treeKey ?? null);
  };

  const level = (row: HTMLElement) => Number(row.getAttribute("aria-level") ?? "1");

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The row handled it (opened or closed itself), or it came from somewhere
    // that is not a row.
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.getAttribute("role") !== "treeitem") return;
    const all = rows();
    const at = all.indexOf(target);
    if (at === -1) return;

    let next: HTMLElement | undefined;
    switch (e.key) {
      case "ArrowDown":
        next = all[at + 1];
        break;
      case "ArrowUp":
        next = all[at - 1];
        break;
      case "Home":
        next = all[0];
        break;
      case "End":
        next = all[all.length - 1];
        break;
      case "ArrowRight": {
        // Closed nodes open themselves; an open one moves to its first child.
        const child = all[at + 1];
        if (target.getAttribute("aria-expanded") === "true" && child && level(child) > level(target)) {
          next = child;
        }
        break;
      }
      case "ArrowLeft": {
        // Open nodes close themselves; anything else moves to its parent.
        const mine = level(target);
        for (let i = at - 1; i >= 0; i--) {
          if (level(all[i]) < mine) {
            next = all[i];
            break;
          }
        }
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    moveTo(next);
  };

  /** A row that takes focus any other way (a click, Tab) becomes the current one. */
  const onFocus = (e: React.FocusEvent) => {
    const key = (e.target as HTMLElement).dataset?.treeKey;
    if (key !== undefined && (e.target as HTMLElement).getAttribute("role") === "treeitem") {
      setActiveKey(key);
    }
  };

  return { treeRef, rowProps, treeProps: { ref: treeRef, onKeyDown, onFocus } };
}

/** The rows on screen, in the order they are shown. */
function rowsIn(tree: HTMLElement | null): HTMLElement[] {
  return Array.from(tree?.querySelectorAll<HTMLElement>("[role='treeitem'][data-tree-key]") ?? []);
}
