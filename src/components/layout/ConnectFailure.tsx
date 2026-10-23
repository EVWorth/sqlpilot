import { AlertCircle, Pencil, RefreshCw, X } from "lucide-react";

interface ConnectFailureProps {
  /** The profile that failed, as the user knows it. */
  name: string;
  message: string;
  onRetry: () => void;
  /** Absent when the profile is gone, so there is nothing to edit. */
  onEdit?: () => void;
  onDismiss: () => void;
}

/**
 * A connect failure, in full, under the tab bar where the connect was asked
 * for.
 *
 * It used to be a 300px status-bar chip that cut the backend's diagnosis off
 * and dismissed itself on the click meant to read it (#804). The two things
 * anyone does next — try again, or fix the settings — are offered here.
 */
export function ConnectFailure({ name, message, onRetry, onEdit, onDismiss }: ConnectFailureProps) {
  return (
    <div
      role="alert"
      data-testid="connect-failure"
      className="absolute left-2 right-2 top-full z-40 mt-1 flex items-start gap-2 rounded border border-[var(--color-border)] surface-error-strong p-2 text-xs text-[var(--color-error)] shadow-lg"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Could not connect to {name}</p>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[var(--color-text-secondary)] select-text">
          {message}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            onClick={onRetry}
            className="flex items-center gap-1 rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
          {onEdit && (
            <button
              onClick={onEdit}
              className="flex items-center gap-1 rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)]"
            >
              <Pencil className="h-3 w-3" />
              Edit connection
            </button>
          )}
        </div>
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 hover:bg-[var(--color-bg-tertiary)]"
        title="Dismiss"
        aria-label="Dismiss connection failure"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
