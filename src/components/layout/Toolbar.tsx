import { Activity, Upload, Sparkles, Sun, Moon, Monitor, ArrowLeftRight, HardDriveDownload, HardDriveUpload, LayoutGrid } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useThemeStore, type ThemeMode } from "../../stores/themeStore";

interface ToolbarProps {
  onShowImport?: () => void;
  onShowBackup?: () => void;
  onShowRestore?: () => void;
  onToggleAI?: () => void;
  aiPanelOpen?: boolean;
}

const themeOrder: ThemeMode[] = ["dark", "light", "system"];
const themeIcons: Record<ThemeMode, typeof Sun> = { dark: Moon, light: Sun, system: Monitor };
const themeLabels: Record<ThemeMode, string> = { dark: "Dark", light: "Light", system: "System" };

export function Toolbar({ onShowImport, onShowBackup, onShowRestore, onToggleAI, aiPanelOpen }: ToolbarProps) {
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const handleOpenAdmin = () => {
    if (!selectedConnectionId) return;
    useEditorStore.getState().addAdminTab(selectedConnectionId);
  };

  const handleOpenCompare = () => {
    useEditorStore.getState().addCompareTab();
  };

  const handleOpenQueryBuilder = () => {
    if (!selectedConnectionId) return;
    const conn = activeConnections.find((c) => c.id === selectedConnectionId);
    const database = conn?.database ?? "";
    if (!database) return;
    useEditorStore.getState().addQueryBuilderTab(selectedConnectionId, database);
  };

  const cycleTheme = () => {
    const idx = themeOrder.indexOf(theme);
    setTheme(themeOrder[(idx + 1) % themeOrder.length]);
  };

  const ThemeIcon = themeIcons[theme];

  return (
    <div className="flex h-10 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3">
      <div className="flex-1" />
      <button
        onClick={handleOpenQueryBuilder}
        disabled={!selectedConnectionId}
        title="Visual Query Builder"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed mr-1"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        <span>Visual Builder</span>
      </button>
      <button
        onClick={handleOpenCompare}
        title="Compare Schemas"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors mr-1"
      >
        <ArrowLeftRight className="h-3.5 w-3.5" />
        <span>Compare</span>
      </button>
      <button
        onClick={handleOpenAdmin}
        disabled={!selectedConnectionId}
        title="Admin Tools"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed mr-1"
      >
        <Activity className="h-3.5 w-3.5" />
        <span>Admin</span>
      </button>
      <button
        onClick={onShowImport}
        disabled={!selectedConnectionId}
        title="Import Data"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed mr-1"
      >
        <Upload className="h-3.5 w-3.5" />
        <span>Import</span>
      </button>
      <button
        onClick={onShowBackup}
        disabled={!selectedConnectionId}
        title="Backup Database"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed mr-1"
      >
        <HardDriveDownload className="h-3.5 w-3.5" />
        <span>Backup</span>
      </button>
      <button
        onClick={onShowRestore}
        disabled={!selectedConnectionId}
        title="Restore Database"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed mr-1"
      >
        <HardDriveUpload className="h-3.5 w-3.5" />
        <span>Restore</span>
      </button>
      <button
        onClick={onToggleAI}
        title="Toggle AI Assistant"
        className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors mr-1 ${
          aiPanelOpen
            ? "bg-brand-600/20 text-brand-400"
            : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
        }`}
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span>AI</span>
      </button>
      <button
        onClick={cycleTheme}
        title={`Theme: ${themeLabels[theme]} (click to cycle)`}
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
      >
        <ThemeIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
