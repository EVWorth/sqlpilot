import { cn } from "../../lib/utils";
import type { ConnectionEnvironment } from "../../types";

const BADGES: Record<ConnectionEnvironment, { label: string; name: string; className: string }> = {
  production: { label: "PROD", name: "Production", className: "surface-error-strong text-[var(--color-error)]" },
  staging: { label: "STG", name: "Staging", className: "surface-warning-strong text-[var(--color-warning)]" },
  development: { label: "DEV", name: "Development", className: "surface-success-strong text-[var(--color-success)]" },
};

/** The full name of an environment, for tooltips and screen readers. */
export function environmentName(environment: ConnectionEnvironment): string {
  return BADGES[environment].name;
}

/**
 * PROD / STG / DEV, wherever a connection is named (#835).
 *
 * It used to appear only as a 9px chip in the status bar, so nothing near
 * the editor or the tab said "production".
 */
export function EnvironmentBadge(
  { environment, className }: { environment: ConnectionEnvironment | null | undefined; className?: string },
) {
  if (!environment) return null;
  const badge = BADGES[environment];
  return (
    <span
      data-testid="environment-badge"
      title={badge.name}
      aria-label={`${badge.name} environment`}
      className={cn(
        "shrink-0 rounded px-1 py-px text-[10px] font-bold uppercase leading-tight",
        badge.className,
        className,
      )}
    >
      {badge.label}
    </span>
  );
}
