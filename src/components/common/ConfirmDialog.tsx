import { AlertTriangle } from "lucide-react";

interface Props {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: Props) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="w-[420px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl">
        <div className="flex items-start gap-3 p-4">
          {danger && (
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500/20">
              <AlertTriangle className="h-4 w-4 text-red-400" />
            </div>
          )}
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {title}
            </h3>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)] whitespace-pre-line">
              {message}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] p-3">
          <button
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`rounded px-3 py-1.5 text-xs font-medium text-white ${
              danger
                ? "bg-red-600 hover:bg-red-500"
                : "bg-brand-600 hover:bg-brand-500"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
