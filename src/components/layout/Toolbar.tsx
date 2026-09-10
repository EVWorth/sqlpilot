import { useThemeStore } from "../../stores/themeStore";
import { FeatureButtons } from "./FeatureButtons";

interface ToolbarProps {
  onShowImport?: () => void;
  onShowBackup?: () => void;
  onShowRestore?: () => void;
  onToggleAI?: () => void;
  aiPanelOpen?: boolean;
  aiEnabled?: boolean;
}

/** The macOS toolbar row. Windows and Linux get the same buttons in TitleBar. */
export function Toolbar(props: ToolbarProps) {
  // Subscribed so the row re-renders when the theme changes; the icon itself
  // lives in FeatureButtons.
  useThemeStore((s) => s.theme);

  return (
    <div className="flex h-10 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3">
      <div className="flex-1" />
      <FeatureButtons
        {...props}
        buttonClassName={(disabled) =>
          `flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors mr-1 ${
            disabled
              ? "text-[var(--color-text-muted)] opacity-40 cursor-not-allowed"
              : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          }`}
        activeButtonClassName="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors mr-1 bg-brand-600/20 text-brand-400"
      />
    </div>
  );
}
