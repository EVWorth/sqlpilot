import { AlertCircle, X } from "lucide-react";
import { useState } from "react";

interface ConnectionErrorChipProps {
  message: string;
  onDismiss: () => void;
}

/**
 * A connection error in the status bar, with its whole message one click away.
 *
 * Render it keyed on the message: the open state belongs to one error, and a
 * later, unrelated one must not arrive with its details already open.
 */
export function ConnectionErrorChip({ message, onDismiss }: ConnectionErrorChipProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    // Click opens the whole message; it used to dismiss it, so the part
    // past 300px — usually the diagnosis — could never be read (#804).
    <div className="relative flex min-h-6 max-w-[300px] items-center gap-0.5">
      <button
        onClick={() => setShowDetails((open) => !open)}
        aria-expanded={showDetails}
        className="flex min-w-0 items-center gap-1 text-[10px] text-[var(--color-error)] hover:text-[var(--color-error)] transition-colors"
        title={message}
      >
        <AlertCircle className="h-3 w-3 flex-shrink-0" />
        <span className="truncate">{message}</span>
      </button>
      <button
        onClick={() => {
          setShowDetails(false);
          onDismiss();
        }}
        className="shrink-0 rounded p-0.5 text-[var(--color-error)] hover:bg-[var(--color-bg-tertiary)]"
        title="Dismiss"
        aria-label="Dismiss connection error"
      >
        <X className="h-2.5 w-2.5" />
      </button>
      {showDetails && (
        <div
          role="alert"
          data-testid="connection-error-details"
          className="absolute bottom-full right-0 z-50 mb-2 w-96 max-w-[80vw] rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 text-[11px] whitespace-pre-wrap break-words text-[var(--color-error)] shadow-lg select-text"
        >
          {message}
        </div>
      )}
    </div>
  );
}
