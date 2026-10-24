import { Lock, Pencil, Plug, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ConnectionProfileSummary } from "../../types";
import { EnvironmentBadge } from "../connection/EnvironmentBadge";

interface ConnectPopoverProps {
  /** Fixed-position coordinates, just under the button that opened it. */
  position: { top: number; left: number };
  /** Saved profiles that are neither open nor opening. */
  profiles: ConnectionProfileSummary[];
  /** The button that opened it: clicks on it are its own, and focus goes back to it. */
  anchor: React.RefObject<HTMLButtonElement | null>;
  onConnect: (profile: ConnectionProfileSummary) => void;
  onEdit: (profile: ConnectionProfileSummary) => void;
  onNew: () => void;
  onProfileContextMenu: (e: React.MouseEvent, profile: ConnectionProfileSummary) => void;
  /** Close without choosing anything. `returnFocus` puts focus back on the anchor. */
  onClose: (returnFocus: boolean) => void;
}

/**
 * The `Connect` button's menu: saved profiles, then "New Connection…".
 *
 * A menu by keyboard as well as by mouse (#827): focus moves to the first
 * entry on open, Up, Down, Home and End move between rows, Right reaches a
 * row's Edit button and Left comes back, and Escape closes it and returns
 * focus to the button.
 */
export function ConnectPopover({
  position,
  profiles,
  anchor,
  onConnect,
  onEdit,
  onNew,
  onProfileContextMenu,
  onClose,
}: ConnectPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-row-item]")?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [anchor, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>("[data-row-item]") ?? [])];
    const current = document.activeElement as HTMLElement | null;
    const row = rows.findIndex((r) => r === current || r.closest("[data-profile-row]")?.contains(current));

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
        return;
      case "Tab":
        onClose(false);
        return;
      case "ArrowDown":
      case "ArrowUp":
      case "Home":
      case "End": {
        e.preventDefault();
        if (rows.length === 0) return;
        const next = e.key === "Home"
          ? 0
          : e.key === "End"
          ? rows.length - 1
          : e.key === "ArrowDown"
          ? (row + 1) % rows.length
          : (row - 1 + rows.length) % rows.length;
        rows[next]?.focus();
        return;
      }
      case "ArrowRight":
      case "ArrowLeft": {
        e.preventDefault();
        // Only a profile row has a second button; "New Connection…" does not.
        const profileRow = current?.closest("[data-profile-row]");
        profileRow?.querySelector<HTMLElement>(e.key === "ArrowRight" ? "[data-row-edit]" : "[data-row-item]")
          ?.focus();
        return;
      }
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Connect to a server"
      onKeyDown={onKeyDown}
      style={{ position: "fixed", top: position.top, left: position.left }}
      className="z-50 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-1 shadow-lg"
    >
      {profiles.length > 0 && (
        <>
          <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Saved Connections
          </div>
          {profiles.map((profile) => (
            <div
              key={profile.id}
              role="none"
              data-profile-row
              className="group flex items-center hover:bg-[var(--color-bg-tertiary)] focus-within:bg-[var(--color-bg-tertiary)]"
              // A profile that is not connected has no tab to right-click,
              // so this is where it can be duplicated or deleted (#795).
              onContextMenu={(e) => onProfileContextMenu(e, profile)}
            >
              <button
                role="menuitem"
                data-row-item
                tabIndex={-1}
                onClick={() => onConnect(profile)}
                // Which server a row is, before connecting to it (#835).
                title={`${profile.username ? `${profile.username}@` : ""}${profile.host}:${profile.port}`}
                className="flex flex-1 min-w-0 items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] outline-none hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
              >
                <Plug className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
                {profile.color && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: profile.color }}
                  />
                )}
                <span className="truncate">{profile.name || profile.host}</span>
                {profile.read_only && (
                  <Lock
                    role="img"
                    aria-label="Read-only connection"
                    className="h-3 w-3 shrink-0 text-[var(--color-warning)]"
                  />
                )}
                <EnvironmentBadge environment={profile.environment} className="ml-auto" />
              </button>
              <button
                role="menuitem"
                data-row-edit
                tabIndex={-1}
                onClick={() => onEdit(profile)}
                className="mr-1 shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-[var(--color-text-primary)] focus-visible:opacity-100"
                title="Edit connection"
                aria-label={`Edit ${profile.name || profile.host}`}
              >
                <Pencil className="h-3 w-3" />
              </button>
            </div>
          ))}
          <div role="separator" className="my-1 border-t border-[var(--color-border)]" />
        </>
      )}
      <button
        role="menuitem"
        data-row-item
        tabIndex={-1}
        onClick={onNew}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] outline-none hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] focus-visible:bg-[var(--color-bg-tertiary)] focus-visible:text-[var(--color-text-primary)]"
      >
        <Plus className="h-3 w-3 shrink-0" />
        <span>New Connection…</span>
      </button>
    </div>
  );
}
