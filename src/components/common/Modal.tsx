import { type ReactNode, useCallback, useEffect, useRef } from "react";

/**
 * The backdrop, the panel, and everything a modal owes a keyboard.
 *
 * Seventeen dialogs each implemented part of this and none implemented all of
 * it: none trapped focus, one moved focus into itself when it opened, four
 * closed on Escape, and none announced themselves as a dialog at all. The
 * result was that opening a dialog left focus behind it — Tab walked the page
 * underneath while the dialog sat on top, and for thirteen of them the only
 * reliable way out was clicking the backdrop.
 *
 * So the contract lives in one place rather than seventeen:
 *
 * - `role="dialog"` and `aria-modal`, so a screen reader stops reading the
 *   page behind it
 * - focus moves into the dialog when it opens
 * - Tab and Shift+Tab cycle within it
 * - Escape closes it
 * - focus returns to whatever opened it
 *
 * What it deliberately does not do is trap the *mouse*. Backdrop clicks close
 * by default because that is what these dialogs already did, and taking it
 * away would be a regression for everyone using one.
 */

/**
 * Things a person can Tab to.
 *
 * `:not([disabled])` and the negative-tabindex exclusion matter: a disabled
 * submit button is a very common last element, and cycling onto it would put
 * focus somewhere that looks broken.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    // Judged by computed style rather than geometry. Measuring would be the
    // more obvious check and it is the wrong one here: it depends on layout,
    // which means it reports everything as invisible under jsdom and the trap
    // would be untestable outside a real browser.
    if (el.hasAttribute("hidden")) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

export interface ModalProps {
  isOpen: boolean;
  /** Escape, the backdrop, and the close button all route here. */
  onClose: () => void;
  /**
   * What this dialog is, for assistive technology.
   *
   * Every dialog has a visible heading, but the markup around it varies enough
   * that wiring `aria-labelledby` to each one would mean touching all of them
   * twice. A name given here is the same promise with less ceremony; pass
   * `labelledBy` instead where an id already exists.
   */
  label: string;
  labelledBy?: string;
  /** Classes for the panel — width, height, overflow. */
  panelClassName?: string;
  /** Stacking, for the dialogs that open on top of other dialogs. */
  className?: string;
  /**
   * Where focus lands when the dialog opens.
   *
   * Left unset, focus goes to the panel itself rather than the first control.
   * That reads the dialog's name first and puts the whole thing one Tab away,
   * which is the right default for a dialog that asks a question. Pass a ref
   * for a dialog that exists to take one specific input.
   */
  initialFocus?: React.RefObject<HTMLElement | null>;
  /** Off for dialogs where a stray click would discard real work. */
  closeOnBackdrop?: boolean;
  children: ReactNode;
}

export function Modal({
  isOpen,
  onClose,
  label,
  labelledBy,
  panelClassName = "",
  className = "fixed inset-0 z-50 flex items-center justify-center bg-black/60",
  initialFocus,
  closeOnBackdrop = true,
  children,
}: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  // Held in a ref rather than state: restoring focus must not depend on a
  // render happening, and the value must survive every render in between.
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    opener.current = document.activeElement;
    const target = initialFocus?.current ?? panel.current;
    target?.focus();

    return () => {
      // Only take focus back if it is still inside the dialog. If something
      // else claimed it while this was open — another dialog, a toast — then
      // yanking it away would be the rude thing to do.
      const active = document.activeElement;
      if (!panel.current || panel.current.contains(active)) {
        (opener.current as HTMLElement | null)?.focus?.();
      }
    };
  }, [isOpen, initialFocus]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;

      const stops = focusableWithin(panel.current);
      // Nothing to cycle between: keep focus on the panel rather than letting
      // Tab walk out into the page underneath.
      if (stops.length === 0) {
        event.preventDefault();
        return;
      }

      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!isOpen) return null;

  return (
    <div
      className={className}
      onMouseDown={(event) => {
        // mousedown on the backdrop itself, not a click that merely ended
        // there: a drag that starts inside the panel and releases outside it
        // should not close the dialog mid-selection.
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`outline-none ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  );
}
