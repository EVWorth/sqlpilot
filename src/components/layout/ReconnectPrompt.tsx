import { RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";

interface ReconnectPromptProps {
  /** The profile, as the user knows it. */
  name: string;
  /** Where the open session still points, e.g. "127.0.0.1:3306". */
  oldServer: string;
  onReconnect: () => void;
  onLater: () => void;
}

/**
 * Asked after saving a connected profile whose connection settings changed.
 *
 * The session was opened with the old host, user or password and keeps them
 * until it is reopened. Saving used to close the dialog with nothing said, so
 * the tab showed the new name while every query still went to the old server
 * (#831).
 */
export function ReconnectPrompt({ name, oldServer, onReconnect, onLater }: ReconnectPromptProps) {
  const reconnectRef = useRef<HTMLButtonElement>(null);

  // The dialog that asked has just closed; the question is where focus goes.
  useEffect(() => {
    reconnectRef.current?.focus();
  }, []);

  return (
    <div
      role="alertdialog"
      aria-label="Reconnect to apply changes"
      data-testid="reconnect-prompt"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onLater();
        }
      }}
      className="absolute left-2 right-2 top-full z-40 mt-1 flex items-start gap-2 rounded border border-[var(--color-border)] surface-warning-strong p-2 text-xs text-[var(--color-text-primary)] shadow-lg"
    >
      <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Reconnect {name} to use the new settings?</p>
        <p className="mt-0.5 text-[var(--color-text-secondary)]">
          The open connection still uses the old ones ({oldServer}). Changes to the server, user, password, SSL or SSH
          apply to the next connection.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            ref={reconnectRef}
            onClick={onReconnect}
            className="flex items-center gap-1 rounded bg-brand-600 px-2 py-1 font-medium text-white hover:bg-brand-700"
          >
            <RefreshCw className="h-3 w-3" />
            Reconnect now
          </button>
          <button
            onClick={onLater}
            className="rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
