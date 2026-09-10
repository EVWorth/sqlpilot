import { Activity, HardDriveDownload, HardDriveUpload, Monitor, Moon, Sparkles, Sun, Upload } from "lucide-react";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { type ThemeMode, useThemeStore } from "../../stores/themeStore";

/**
 * The feature buttons, in one place.
 *
 * They used to live in both `TitleBar` (Windows and Linux) and `Toolbar`
 * (macOS), which meant adding one required editing two files and forgetting
 * the second shipped a feature to one platform and not the other (#452). The
 * two hosts still look different — the title bar's row is tighter — so each
 * passes its own class builder rather than the button set being forced into
 * one appearance.
 */

const themeIcons: Record<ThemeMode, typeof Sun> = { dark: Moon, light: Sun, system: Monitor };
const themeLabels: Record<ThemeMode, string> = { dark: "Dark", light: "Light", system: "System" };

export interface FeatureButtonsProps {
  onShowImport?: () => void;
  onShowBackup?: () => void;
  onShowRestore?: () => void;
  onToggleAI?: () => void;
  aiPanelOpen?: boolean;
  aiEnabled?: boolean;
  /** The host's button styling, given whether the button is disabled. */
  buttonClassName: (disabled: boolean) => string;
  /** Styling for the AI button when the panel is open. */
  activeButtonClassName?: string;
}

export function FeatureButtons({
  onShowImport,
  onShowBackup,
  onShowRestore,
  onToggleAI,
  aiPanelOpen,
  aiEnabled,
  buttonClassName,
  activeButtonClassName,
}: FeatureButtonsProps) {
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const theme = useThemeStore((s) => s.theme);
  const cycleTheme = useThemeStore((s) => s.cycleTheme);

  const handleOpenAdmin = () => {
    if (!selectedConnectionId) return;
    useEditorStore.getState().addAdminTab(selectedConnectionId);
  };

  // Everything but the theme toggle needs somewhere to act.
  const disabled = !selectedConnectionId;
  const ThemeIcon = themeIcons[theme];

  return (
    <>
      <button
        onClick={handleOpenAdmin}
        disabled={disabled}
        title="Admin Tools"
        className={buttonClassName(disabled)}
      >
        <Activity className="h-3.5 w-3.5" />
        <span>Admin</span>
      </button>
      <button
        onClick={onShowImport}
        disabled={disabled}
        title="Import Data"
        className={buttonClassName(disabled)}
      >
        <Upload className="h-3.5 w-3.5" />
        <span>Import</span>
      </button>
      <button
        onClick={onShowBackup}
        disabled={disabled}
        title="Backup Database"
        className={buttonClassName(disabled)}
      >
        <HardDriveDownload className="h-3.5 w-3.5" />
        <span>Backup</span>
      </button>
      <button
        onClick={onShowRestore}
        disabled={disabled}
        title="Restore Database"
        className={buttonClassName(disabled)}
      >
        <HardDriveUpload className="h-3.5 w-3.5" />
        <span>Restore</span>
      </button>
      {aiEnabled && (
        <button
          onClick={onToggleAI}
          title="Toggle AI Assistant"
          className={aiPanelOpen && activeButtonClassName
            ? activeButtonClassName
            : buttonClassName(false)}
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>AI</span>
        </button>
      )}
      <button
        onClick={cycleTheme}
        // Not gated on a connection: the theme is the app's, not the server's.
        title={`Theme: ${themeLabels[theme]} (click to cycle)`}
        className={buttonClassName(false)}
      >
        <ThemeIcon className="h-3.5 w-3.5" />
      </button>
    </>
  );
}
