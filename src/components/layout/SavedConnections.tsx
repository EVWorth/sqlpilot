import { Database, Plug, Plus } from "lucide-react";
import { requestConnect, requestNewConnection } from "../../lib/connect-request";
import { useConnectionStore } from "../../stores/connectionStore";
import type { ConnectionEnvironment } from "../../types";

const ENV_LABELS: Record<ConnectionEnvironment, { label: string; className: string }> = {
  production: { label: "PROD", className: "surface-error-strong text-[var(--color-error)]" },
  staging: { label: "STG", className: "surface-warning-strong text-[var(--color-warning)]" },
  development: { label: "DEV", className: "surface-success-strong text-[var(--color-success)]" },
};

/**
 * What the sidebar offers when no connection is selected: the saved profiles,
 * each a click from connecting, or a first-run prompt when there are none.
 *
 * It said only "No connection selected", and the way to a profile was an
 * icon-only `+` in the tab bar (#817).
 */
export function SavedConnections() {
  const profiles = useConnectionStore((s) => s.profiles);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const connecting = useConnectionStore((s) => s.connecting);

  const openIds = new Set(activeConnections.map((c) => c.profile_id));
  const available = profiles.filter((p) => !openIds.has(p.id));

  if (profiles.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <Database className="h-8 w-8 text-[var(--color-text-muted)] opacity-40" />
        <p className="text-xs text-[var(--color-text-secondary)]">No saved connections yet</p>
        <button
          onClick={requestNewConnection}
          className="flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
        >
          <Plus className="h-3.5 w-3.5" />
          Create your first connection
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2">
      <p className="px-1 text-xs text-[var(--color-text-muted)]">No connection selected</p>
      {available.length > 0 && (
        <h2 className="mt-1 px-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Saved connections
        </h2>
      )}
      <ul className="flex flex-col">
        {available.map((profile) => {
          const env = profile.environment ? ENV_LABELS[profile.environment] : undefined;
          const name = profile.name || profile.host;
          const isConnecting = connecting.includes(profile.id);
          return (
            <li
              key={profile.id}
              data-testid="saved-connection"
              className="flex items-center gap-2 rounded px-1 py-1 hover:bg-[var(--color-bg-tertiary)]"
            >
              {profile.color && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: profile.color }} />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs text-[var(--color-text-primary)]">{name}</span>
                  {env && (
                    <span className={`shrink-0 rounded px-1 text-[9px] font-bold ${env.className}`}>{env.label}</span>
                  )}
                </div>
                <div className="truncate text-[10px] text-[var(--color-text-muted)]">
                  {profile.username ? `${profile.username}@` : ""}
                  {profile.host}
                  {profile.port !== 3306 ? `:${profile.port}` : ""}
                </div>
              </div>
              <button
                onClick={() => requestConnect(profile.id)}
                disabled={isConnecting}
                aria-label={`Connect to ${name}`}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
              >
                <Plug className="h-3 w-3" />
                {isConnecting ? "Connecting…" : "Connect"}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        onClick={requestNewConnection}
        className="mt-1 flex items-center gap-1.5 rounded px-1 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
      >
        <Plus className="h-3 w-3" />
        New Connection…
      </button>
    </div>
  );
}
