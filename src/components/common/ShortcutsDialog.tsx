import { useState, useEffect } from "react";
import { X, Keyboard, Info } from "lucide-react";
import { api } from "../../lib/tauri-api";

interface HelpDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: "shortcuts" | "about";
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

export function HelpDialog({ isOpen, onClose, initialTab = "shortcuts" }: HelpDialogProps) {
  const [tab, setTab] = useState<"shortcuts" | "about">(initialTab);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    if (isOpen) setTab(initialTab);
  }, [isOpen, initialTab]);

  useEffect(() => {
    api.getAppVersion().then(setAppVersion).catch((e) => console.error("Failed to get app version", e));
  }, []);

  if (!isOpen) return null;

  const tabClass = (active: boolean) =>
    `flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
      active
        ? "border-[var(--color-accent)] text-[var(--color-text-primary)]"
        : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 pt-3 pb-0">
          <div className="flex">
            <button className={tabClass(tab === "shortcuts")} onClick={() => setTab("shortcuts")}>
              <Keyboard className="h-3.5 w-3.5" />
              Keyboard Shortcuts
            </button>
            <button className={tabClass(tab === "about")} onClick={() => setTab("about")}>
              <Info className="h-3.5 w-3.5" />
              About
            </button>
          </div>
          <button
            onClick={onClose}
            className="mb-1 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Shortcuts tab */}
        {tab === "shortcuts" && (
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
        )}

        {/* About tab */}
        {tab === "about" && (
          <div className="flex flex-col items-center gap-4 p-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-600/20">
              <img src="/icon.svg" alt="SQLPilot" className="h-10 w-10" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">SQLPilot</h2>
              {appVersion && (
                <p className="text-xs text-[var(--color-text-muted)]">Version {appVersion}</p>
              )}
            </div>
            <p className="text-xs text-[var(--color-text-secondary)] max-w-xs">
              A blazing-fast, AI-powered MySQL GUI — built with Rust &amp; React.
            </p>
            <div className="h-px w-full bg-[var(--color-border)]" />
            <div className="flex flex-col items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span>Built with Tauri · Rust · React · TypeScript</span>
              <a
                href="https://www.buymeacoffee.com/evworth"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-yellow-400 px-4 py-1.5 text-xs font-semibold text-black hover:bg-yellow-300 transition-colors"
              >
                ☕ Buy me a coffee
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Keep old export name as alias for backwards compat
export { HelpDialog as ShortcutsDialog };
