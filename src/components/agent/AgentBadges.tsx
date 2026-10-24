import type { DataPosture } from "../../lib/bindings";
import { SHARING_OPTIONS } from "../../stores/agentStore";

/**
 * The two words that say what an agent can do with a connection: which
 * environment it is, and how much of it is shared. One look, in the settings
 * dialog and the session header alike.
 */

export function EnvironmentBadge({ environment }: { environment: string }) {
  // Production is the one that has to be visible at a glance; the rest are
  // noise if they shout.
  const production = environment === "production";
  return (
    <span
      data-testid="environment-badge"
      className={production
        ? "rounded surface-error px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--color-error)]"
        : "rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-muted)]"}
    >
      {environment}
    </span>
  );
}

export function PostureBadge({ posture }: { posture: DataPosture }) {
  const option = SHARING_OPTIONS.find((o) => o.value === posture);
  return (
    <span
      data-testid="posture-badge"
      title={option?.detail}
      className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
    >
      {option?.label ?? posture}
    </span>
  );
}
