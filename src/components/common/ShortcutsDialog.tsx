import { X } from "lucide-react";

interface ShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutEntry {
  keys: string;
  description: string;
}

const sections: { title: string; shortcuts: ShortcutEntry[] }[] = [
  {
    title: "Editor",
    shortcuts: [
      { keys: "Ctrl+Enter", description: "Execute query" },
      { keys: "F5", description: "Execute query" },
      { keys: "Ctrl+F", description: "Find in editor" },
      { keys: "Ctrl+H", description: "Find & Replace" },
      { keys: "Ctrl+Shift+F", description: "Format SQL" },
      { keys: "Ctrl+S", description: "Save as favorite" },
    ],
  },
  {
    title: "Navigation",
    shortcuts: [
      { keys: "Ctrl+N", description: "New query tab" },
      { keys: "Ctrl+T", description: "New query tab" },
      { keys: "Ctrl+W", description: "Close active tab" },
      { keys: "Ctrl+Tab", description: "Next tab" },
      { keys: "Ctrl+Shift+Tab", description: "Previous tab" },
      { keys: "Ctrl+Shift+C", description: "Toggle sidebar" },
    ],
  },
  {
    title: "General",
    shortcuts: [
      { keys: "F1", description: "Show keyboard shortcuts" },
    ],
  },
];

export function ShortcutsDialog({ isOpen, onClose }: ShortcutsDialogProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4">
          {sections.map((section) => (
            <div key={section.title} className="mb-4 last:mb-0">
              <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                {section.title}
              </h3>
              <div className="space-y-1">
                {section.shortcuts.map((s) => (
                  <div
                    key={s.keys + s.description}
                    className="flex items-center justify-between rounded px-2 py-1.5"
                  >
                    <span className="text-xs text-[var(--color-text-secondary)]">
                      {s.description}
                    </span>
                    <kbd className="rounded bg-[var(--color-bg-primary)] px-2 py-0.5 text-[11px] font-mono text-[var(--color-text-muted)] border border-[var(--color-border)]">
                      {s.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
