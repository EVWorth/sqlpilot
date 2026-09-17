import { useEffect, useMemo, useRef, useState } from "react";
import { type Action, runAction, search } from "../../lib/actions";
import { Modal } from "./Modal";

/**
 * Every action, one keystroke away.
 *
 * §1.3 makes the keyboard a headline promise — "every action is accessible via
 * keyboard shortcut… mouse is supported but never required" — and rests it on
 * "a VS Code-style command palette", which did not exist. Per-action bindings
 * do not scale to thirty actions; the palette is how the promise holds.
 *
 * It also teaches. Each row shows its own shortcut, so the way to stop needing
 * the palette for a given action is to use the palette for it a few times.
 *
 * Built on `Modal`, so it inherits the focus contract rather than restating
 * it: focus in on open, trapped while open, Escape closes, focus back to
 * wherever you were when you are done.
 */

/** Opened by any of these, because muscle memory differs by editor. */
function isOpenChord(event: KeyboardEvent): boolean {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.shiftKey && event.key.toLowerCase() === "p") return true;
  // Plain Ctrl+P, as long as nothing else has claimed it.
  if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") return true;
  return false;
}

export function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => search(query), [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isOpenChord(event)) return;
      event.preventDefault();
      setQuery("");
      setSelected(0);
      setIsOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A filtered list whose selection points past the end selects nothing, so
  // Enter would do nothing and look broken.
  useEffect(() => {
    setSelected((current) => (current >= matches.length ? 0 : current));
  }, [matches.length]);

  // Keep the highlighted row visible when arrowing past the fold.
  useEffect(() => {
    list.current?.querySelector("[data-selected=\"true\"]")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = (action: Action) => {
    setIsOpen(false);
    // After the dialog closes, so focus is back where it belongs before the
    // action runs — several of these open dialogs of their own.
    queueMicrotask(() => runAction(action.id));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((current) => (current + 1) % Math.max(matches.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((current) => (current - 1 + matches.length) % Math.max(matches.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const action = matches[selected];
      if (action) choose(action);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      label="Command palette"
      initialFocus={input}
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[12vh]"
      panelClassName="w-[560px] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl"
    >
      <div onKeyDown={onKeyDown}>
        <input
          ref={input}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          placeholder="Type a command…"
          aria-label="Command"
          aria-controls="command-palette-results"
          role="combobox"
          aria-expanded
          className="w-full border-b border-[var(--color-border)] bg-transparent px-4 py-3 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
        />

        <div
          ref={list}
          id="command-palette-results"
          role="listbox"
          aria-label="Commands"
          className="max-h-[50vh] overflow-y-auto py-1"
        >
          {matches.length === 0
            ? (
              <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
                No command matches “{query}”.
              </p>
            )
            : matches.map((action, index) => (
              <button
                key={action.id}
                role="option"
                aria-selected={index === selected}
                data-selected={index === selected}
                onMouseMove={() => setSelected(index)}
                onClick={() => choose(action)}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left text-xs transition-colors ${
                  index === selected
                    ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
                    : "text-[var(--color-text-secondary)]"
                }`}
              >
                <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                  {action.category}
                </span>
                <span className="flex-1 truncate">{action.label}</span>
                {action.shortcut && (
                  <kbd className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                    {action.shortcut}
                  </kbd>
                )}
              </button>
            ))}
        </div>
      </div>
    </Modal>
  );
}
