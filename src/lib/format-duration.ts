/**
 * Durations as a person reads them: "18ms", "51.2s", "3m 4s", "2h 5m",
 * "14d 0h". Two units at most; the smaller is dropped once the larger makes
 * it noise.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) {
    const s = seconds.toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}s`;
  }
  return formatWhole(Math.floor(seconds));
}

/** Whole seconds, as the server reports them (PROCESSLIST's Time). */
export function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return formatWhole(Math.floor(seconds));
}

function formatWhole(total: number): string {
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${secs}s`;
}
