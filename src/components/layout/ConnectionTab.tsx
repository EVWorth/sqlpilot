import { Database, Lock, RefreshCw, X } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ConnectionInfo, ConnectionProfileSummary } from "../../types";
import { EnvironmentBadge } from "../connection/EnvironmentBadge";

interface ConnectionTabProps {
  conn: ConnectionInfo;
  /** The saved profile behind it, when it still exists. */
  profile: ConnectionProfileSummary | undefined;
  isSelected: boolean;
  /** Whether this tab holds the strip's one Tab stop. */
  focusable: boolean;
  /** What the health checker last said. */
  state: "Connected" | "Disconnected";
  /** The profile's connection settings changed after this connected (#831). */
  stale?: boolean;
  onSelect: () => void;
  onDisconnect: () => void;
  /** Open the tab's menu at a point: the pointer, or under the tab from the keyboard. */
  onMenu: (x: number, y: number) => void;
}

/**
 * One open server in the connection strip.
 *
 * A real tab (#827): reachable with Tab, selected with Enter or Space, and
 * its Edit / Duplicate / Disconnect / Delete menu opens with Shift+F10 or the
 * Menu key as well as with a right-click. Moving between tabs is the strip's
 * job (`ConnectionTabs`), so it can treat server and SQLite tabs as one row.
 */
export function ConnectionTab({
  conn,
  profile,
  isSelected,
  focusable,
  state,
  stale = false,
  onSelect,
  onDisconnect,
  onMenu,
}: ConnectionTabProps) {
  const label = profile?.name || profile?.host || conn.id;
  // The name truncates at 180px, so the tooltip is where the whole of it,
  // and the server it points at, can be read (#835).
  const host = profile ? `${profile.host}:${profile.port}` : `${conn.host}:${conn.port}`;
  const tooltip = `${label} — ${profile?.username ? `${profile.username}@` : ""}${host}`
    + (stale ? `\nStill connected to ${conn.host}:${conn.port}; reconnect to apply the new settings.` : "");

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      onMenu(rect.left, rect.bottom);
    } else if (e.key === "Delete") {
      e.preventDefault();
      onDisconnect();
    }
  };

  return (
    <div
      role="tab"
      aria-selected={isSelected}
      tabIndex={focusable ? 0 : -1}
      data-connection-id={conn.id}
      title={tooltip}
      className={cn(
        "group relative flex h-7 min-w-0 max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs select-none outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        isSelected
          ? "bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] shadow-sm"
          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]",
      )}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
    >
      {/* Active indicator bar */}
      {isSelected && <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-brand-500" />}

      {
        /* Green while the server answers, red once the health checker
          says it does not; the third FR-1.3.2 state, connecting, is
          the placeholder tab. It was green whatever was true (#294). */
      }
      <Database
        role="img"
        aria-label={state}
        className={cn(
          "h-3 w-3 shrink-0",
          state === "Disconnected" ? "text-[var(--color-error)]" : "text-[var(--color-success)]",
        )}
      />

      {profile?.color && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: profile.color }}
        />
      )}

      {
        /* Read-only is enforced in the executor, but a guard the user
          cannot see is one they will be surprised by — the refusal
          arrives only after they run something (#277). */
      }
      {profile?.read_only && (
        <Lock
          role="img"
          aria-label="Read-only connection"
          className="h-3 w-3 shrink-0 text-[var(--color-warning)]"
        />
      )}

      <EnvironmentBadge environment={profile?.environment} />

      <span className="truncate">{label}</span>

      {stale && (
        <RefreshCw
          role="img"
          aria-label="Settings changed — reconnect to apply"
          className="h-3 w-3 shrink-0 text-[var(--color-warning)]"
        />
      )}

      <button
        // The tab itself is the Tab stop; Delete on it disconnects, so this
        // stays out of the order rather than being a second stop per tab.
        tabIndex={-1}
        className={cn(
          "ml-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
          isSelected && "opacity-60",
          "hover:bg-[var(--color-bg-secondary)] hover:opacity-100",
        )}
        onClick={(e) => {
          e.stopPropagation();
          onDisconnect();
        }}
        title="Disconnect"
        aria-label={`Disconnect ${label}`}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}
