import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useActionContext } from "../../hooks/useActionContext";
import { actionById, CONNECT_FIRST, isEnabled, MENUS, runAction } from "../../lib/actions";
import { requestConnect } from "../../lib/connect-request";
import { cn } from "../../lib/utils";
import { useConnectionStore } from "../../stores/connectionStore";

/** Where focus goes once a menu (or the Connect to submenu) has rendered. */
type PendingFocus = "first" | "last" | "submenu" | null;

const ITEM = "[data-menu-item]:not([disabled])";
const SUBMENU_ITEM = "[data-submenu-item]:not([disabled])";

/** Focus the next, previous, first or last of `items`, relative to `current`. */
function moveFocus(items: HTMLElement[], current: Element | null, key: string): boolean {
  if (items.length === 0) return false;
  const at = items.findIndex((item) => item === current);
  let next: number;
  if (key === "ArrowDown") next = (at + 1) % items.length;
  else if (key === "ArrowUp") next = at === -1 ? items.length - 1 : (at - 1 + items.length) % items.length;
  else if (key === "Home") next = 0;
  else if (key === "End") next = items.length - 1;
  else return false;
  items[next]?.focus();
  return true;
}

/**
 * The in-app menu bar (Windows and Linux; macOS uses the native one).
 *
 * Follows the WAI-ARIA menubar pattern so it works without a mouse (#827):
 * one Tab stop for the bar, Left and Right between titles, Down or Enter to
 * open, Up, Down, Home and End inside a menu, Escape back to the title, and
 * hovering another title while one is open switches to it.
 */
export function MenuBar() {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [connectToOpen, setConnectToOpen] = useState(false);
  // The title that holds the bar's one Tab stop.
  const [focusedTitle, setFocusedTitle] = useState(0);
  const pendingFocus = useRef<PendingFocus>(null);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const openProfileIds = new Set(activeConnections.map((c) => c.profile_id));
  const connecting = useConnectionStore((s) => s.connecting);
  const barRef = useRef<HTMLDivElement>(null);
  const titleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const context = useActionContext();

  useEffect(() => {
    if (openMenu === null) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    // Escape while focus is elsewhere, as after opening a menu by mouse. From
    // inside the bar the keydown handlers below take it first.
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openMenu]);

  // Move focus once the menu it is going to exists.
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    if (target === "submenu") {
      const first = submenuRef.current?.querySelector<HTMLElement>(SUBMENU_ITEM);
      if (!first) return;
      first.focus();
    } else {
      const items = [...(dropdownRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
      if (items.length === 0) return;
      (target === "first" ? items[0] : items[items.length - 1])?.focus();
    }
    pendingFocus.current = null;
  }, [openMenu, connectToOpen]);

  const open = (idx: number, focus: PendingFocus = null) => {
    pendingFocus.current = focus;
    setConnectToOpen(false);
    setFocusedTitle(idx);
    setOpenMenu(idx);
  };

  const close = (returnFocus: boolean) => {
    const idx = openMenu;
    setOpenMenu(null);
    setConnectToOpen(false);
    if (returnFocus && idx !== null) titleRefs.current[idx]?.focus();
  };

  const step = (from: number, by: number) => (from + by + MENUS.length) % MENUS.length;

  const handleItemClick = (id: string) => {
    close(true);
    runAction(id);
  };

  const handleConnect = (profileId: string) => {
    setOpenMenu(null);
    setConnectToOpen(false);
    requestConnect(profileId);
  };

  const backToConnectTo = () => {
    setConnectToOpen(false);
    dropdownRef.current?.querySelector<HTMLElement>("[data-connect-to]")?.focus();
  };

  const onTitleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let target: number | null = null;
    if (e.key === "ArrowRight") target = step(idx, 1);
    else if (e.key === "ArrowLeft") target = step(idx, -1);
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = MENUS.length - 1;

    if (target !== null) {
      e.preventDefault();
      setFocusedTitle(target);
      titleRefs.current[target]?.focus();
      if (openMenu !== null) open(target, "first");
      return;
    }
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(idx, "first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      open(idx, "last");
    } else if (e.key === "Escape" && openMenu !== null) {
      e.stopPropagation();
      close(true);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent, idx: number) => {
    const inSubmenu = !!submenuRef.current?.contains(e.target as Node);
    const onConnectTo = (e.target as HTMLElement).dataset.connectTo !== undefined;

    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      const scope = inSubmenu ? submenuRef.current : dropdownRef.current;
      const items = [...(scope?.querySelectorAll<HTMLElement>(inSubmenu ? SUBMENU_ITEM : ITEM) ?? [])];
      if (moveFocus(items, document.activeElement, e.key)) e.preventDefault();
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (onConnectTo) {
        pendingFocus.current = "submenu";
        setConnectToOpen(true);
      } else {
        const next = step(idx, 1);
        titleRefs.current[next]?.focus();
        open(next, "first");
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (inSubmenu) {
        backToConnectTo();
      } else {
        const previous = step(idx, -1);
        titleRefs.current[previous]?.focus();
        open(previous, "first");
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Handled here; the document listener would close the whole menu.
      e.stopPropagation();
      if (inSubmenu) backToConnectTo();
      else close(true);
    } else if (e.key === "Tab") {
      // Leaving the menu closes it; focus carries on to wherever Tab goes.
      close(false);
    }
  };

  const itemClass = "flex w-full items-center justify-between gap-8 px-3 py-1 text-left text-xs "
    + "text-[var(--color-text-primary)] outline-none transition-colors focus-visible:bg-[var(--color-bg-tertiary)]";

  return (
    <div ref={barRef} role="menubar" aria-label="Application menu" className="flex items-center">
      {MENUS.map((menu, idx) => (
        <div key={menu.label} className="relative">
          <button
            ref={(el) => {
              titleRefs.current[idx] = el;
            }}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openMenu === idx}
            tabIndex={focusedTitle === idx ? 0 : -1}
            onClick={() => (openMenu === idx ? close(false) : open(idx))}
            // Once one menu is open, moving across the bar opens the others,
            // as every desktop menu bar does.
            onMouseEnter={() => {
              if (openMenu !== null && openMenu !== idx) open(idx);
            }}
            onKeyDown={(e) => onTitleKeyDown(e, idx)}
            className={cn(
              "rounded px-2.5 py-1 text-xs transition-colors",
              openMenu === idx
                ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]",
            )}
          >
            {menu.label}
          </button>

          {openMenu === idx && (
            <div
              ref={dropdownRef}
              role="menu"
              aria-label={menu.label}
              onKeyDown={(e) => onMenuKeyDown(e, idx)}
              className="absolute left-0 top-full z-50 min-w-48 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-1 shadow-lg"
            >
              {menu.entries.map((entry, i) => {
                if (entry.type === "separator") {
                  return <div key={i} role="separator" className="my-1 h-px bg-[var(--color-border)]" />;
                }
                if (entry.type === "connect-to") {
                  // The saved profiles, one click from the menu bar (#817).
                  return (
                    <div
                      key={i}
                      className="relative"
                      onMouseEnter={() => setConnectToOpen(true)}
                      onMouseLeave={() => setConnectToOpen(false)}
                    >
                      <button
                        role="menuitem"
                        data-menu-item
                        data-connect-to
                        tabIndex={-1}
                        onClick={() => setConnectToOpen((v) => !v)}
                        aria-haspopup="menu"
                        aria-expanded={connectToOpen}
                        className={cn(itemClass, "hover:bg-[var(--color-bg-tertiary)]")}
                      >
                        <span>Connect to</span>
                        <ChevronRight className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
                      </button>
                      {connectToOpen && (
                        <div
                          ref={submenuRef}
                          role="menu"
                          aria-label="Connect to"
                          className="absolute left-full top-0 z-50 min-w-48 max-w-72 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-1 shadow-lg"
                        >
                          {profiles.length === 0 && (
                            <p className="px-3 py-1 text-xs text-[var(--color-text-muted)]">No saved connections</p>
                          )}
                          {profiles.map((profile) => {
                            const isOpen = openProfileIds.has(profile.id);
                            const isOpening = connecting.includes(profile.id);
                            return (
                              <button
                                key={profile.id}
                                role="menuitem"
                                data-submenu-item
                                tabIndex={-1}
                                disabled={isOpen || isOpening}
                                onClick={() => handleConnect(profile.id)}
                                className={cn(
                                  itemClass,
                                  "gap-4 hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 disabled:hover:bg-transparent",
                                )}
                              >
                                <span className="truncate">{profile.name || profile.host}</span>
                                {isOpen && <span className="shrink-0 text-[var(--color-text-muted)]">connected</span>}
                                {!isOpen && isOpening && (
                                  <span className="shrink-0 text-[var(--color-text-muted)]">connecting</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }
                const action = actionById(entry.id);
                if (!action) return null;
                // Greyed rather than hidden, so the menu keeps its shape and
                // says what is missing (#821). Still focusable, as the
                // menubar pattern asks, so arrowing past it is not a jump.
                const enabled = isEnabled(action, context);
                return (
                  <button
                    key={entry.id}
                    role="menuitem"
                    data-menu-item
                    tabIndex={-1}
                    aria-disabled={!enabled || undefined}
                    title={enabled ? undefined : CONNECT_FIRST}
                    onClick={() => {
                      if (enabled) handleItemClick(entry.id);
                    }}
                    className={cn(
                      itemClass,
                      enabled ? "hover:bg-[var(--color-bg-tertiary)]" : "cursor-default opacity-50",
                    )}
                  >
                    <span>{action.label}</span>
                    {action.shortcut && (
                      <span className="shrink-0 text-[var(--color-text-muted)]">{action.shortcut}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
