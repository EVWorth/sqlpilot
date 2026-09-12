import { Bot, Check, Copy, Eye, EyeOff, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentConnection, Harness } from "../../lib/bindings";
import {
  endpointSummary,
  HARNESSES,
  type Sharing,
  SHARING_OPTIONS,
  sharingOf,
  useAgentStore,
} from "../../stores/agentStore";

/**
 * Which databases an agent harness can reach, and how to point one here.
 *
 * The screen is built around one idea: a user should be able to look at it and
 * say what the thing attached to their production database is allowed to see.
 * So the posture is a word on the row rather than a setting three clicks in,
 * production is marked, and a connection nobody has shared reads as "Not
 * shared" rather than as an empty field.
 *
 * The token is shown on request rather than by default. It is not a secret
 * from the user — they have to paste it into their own harness — but it is a
 * secret from whoever is standing behind them.
 */

export interface AgentSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const labelClasses = "mb-1 block text-xs font-medium text-[var(--color-text-secondary)]";

/** A copy button that says it worked, because a silent copy reads as broken. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function EnvironmentBadge({ environment }: { environment: string }) {
  // Production is the one that has to be visible at a glance; the rest are
  // noise if they shout.
  const production = environment === "production";
  return (
    <span
      data-testid="environment-badge"
      className={production
        ? "rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-400"
        : "rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-muted)]"}
    >
      {environment}
    </span>
  );
}

function ConnectionRow({ connection }: { connection: AgentConnection }) {
  const share = useAgentStore((s) => s.share);
  const unlockDdl = useAgentStore((s) => s.unlockDdl);
  const sharing = sharingOf(connection);
  const shared = sharing !== "none";

  return (
    <div className="flex flex-col gap-1 border-b border-[var(--color-border)] px-1 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-sm text-[var(--color-text-primary)]">
          {connection.name}
        </span>
        <EnvironmentBadge environment={connection.environment} />
        {connection.readOnly && (
          <span className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-muted)]">
            read-only
          </span>
        )}
        <select
          aria-label={`How ${connection.name} is shared`}
          value={sharing}
          onChange={(e) => void share(connection.connectionId, e.target.value as Sharing)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
        >
          {SHARING_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {shared && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {SHARING_OPTIONS.find((o) => o.value === sharing)?.detail}
          {!connection.connected && " Takes effect when you connect."}
        </p>
      )}

      {
        /* Production schema changes are refused outright unless this is on, and
          it lapses when the app closes — so it belongs next to the connection
          rather than in a preferences pane someone sets once and forgets. */
      }
      {shared && connection.environment === "production" && !connection.readOnly && (
        <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={connection.ddlUnlocked}
            onChange={(e) => void unlockDdl(connection.connectionId, e.target.checked)}
          />
          Allow schema changes this session (still asks before each one)
        </label>
      )}
    </div>
  );
}

export function AgentSettingsDialog({ isOpen, onClose }: AgentSettingsDialogProps) {
  const { endpoint, connections, error, setup } = useAgentStore();
  const refresh = useAgentStore((s) => s.refresh);
  const start = useAgentStore((s) => s.start);
  const stop = useAgentStore((s) => s.stop);
  const rotateToken = useAgentStore((s) => s.rotateToken);
  const loadSetup = useAgentStore((s) => s.loadSetup);

  const [harness, setHarness] = useState<Harness>("claude-code");
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    if (isOpen) void refresh();
  }, [isOpen, refresh]);

  // The setup text carries the URL and the token, so it is re-fetched whenever
  // either could have changed rather than being cached against the harness.
  useEffect(() => {
    if (isOpen && endpoint?.running) void loadSetup(harness);
  }, [isOpen, harness, endpoint?.running, endpoint?.token, loadSetup]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative max-h-[85vh] w-[620px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-brand-400" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Agents</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 p-4">
          {error && (
            <p role="alert" className="rounded bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase text-[var(--color-text-secondary)]">
              Endpoint
            </h3>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {endpointSummary(endpoint)}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void (endpoint?.running ? stop() : start())}
                className="rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500"
              >
                {endpoint?.running ? "Stop" : "Start"}
              </button>
              <button
                type="button"
                onClick={() => void rotateToken()}
                title="Issue a new token. Every harness you have configured stops working until you give it the new one."
                className="flex items-center gap-1 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
              >
                <RefreshCw className="h-3 w-3" />
                New token
              </button>
            </div>

            {endpoint?.token && (
              <div className="mt-2 flex items-center gap-2">
                <span className={labelClasses}>Token</span>
                <code className="flex-1 truncate rounded bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-xs text-[var(--color-text-primary)]">
                  {showToken ? endpoint.token : "•".repeat(32)}
                </code>
                <button
                  type="button"
                  aria-label={showToken ? "Hide token" : "Show token"}
                  onClick={() => setShowToken(!showToken)}
                  className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                <CopyButton value={endpoint.token} label="Copy token" />
              </div>
            )}
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase text-[var(--color-text-secondary)]">
              Connect a harness
            </h3>
            <select
              aria-label="Harness"
              value={harness}
              onChange={(e) => setHarness(e.target.value as Harness)}
              className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
            >
              {HARNESSES.map((h) => (
                <option key={h.value} value={h.value}>
                  {h.label}
                </option>
              ))}
            </select>
            {endpoint?.running && setup
              ? (
                <div className="mt-2 flex items-start gap-2">
                  <pre className="flex-1 overflow-x-auto rounded bg-[var(--color-bg-secondary)] p-2 font-mono text-[11px] text-[var(--color-text-primary)]">
{setup}
                  </pre>
                  <CopyButton value={setup} label="Copy setup command" />
                </div>
              )
              : (
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  Start the endpoint to see the command for this harness.
                </p>
              )}
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase text-[var(--color-text-secondary)]">
              Shared connections
            </h3>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              An agent can only see what you share here. Writes and schema changes are always approved in this window,
              whatever the harness has been told it may do.
            </p>
            <div className="mt-2">
              {connections.length === 0
                ? (
                  <p className="text-xs text-[var(--color-text-muted)]">
                    No saved connections yet.
                  </p>
                )
                : connections.map((connection) => (
                  <ConnectionRow key={connection.connectionId} connection={connection} />
                ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
