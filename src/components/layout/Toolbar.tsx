import { Database, Keyboard, Activity, Upload, Sparkles } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import { useConnectionStore } from "../../stores/connectionStore";

interface ToolbarProps {
  onShowShortcuts?: () => void;
  onShowImport?: () => void;
  onToggleAI?: () => void;
  aiPanelOpen?: boolean;
}

export function Toolbar({ onShowShortcuts, onShowImport, onToggleAI, aiPanelOpen }: ToolbarProps) {
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);

  const handleOpenAdmin = () => {
    if (!selectedConnectionId) return;
    useEditorStore.getState().addAdminTab(selectedConnectionId);
  };

  return (
    <div className="flex h-10 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3">
      <div className="flex items-center gap-2">
        <Database className="h-5 w-5 text-brand-400" />
        <span className="text-sm font-semibold text-[var(--color-text-primary)]">
          MySQL AI Studio
        </span>
      </div>
      <div className="flex-1" />
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
        onClick={onShowShortcuts}
        title="Keyboard Shortcuts (F1)"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
      >
        <Keyboard className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
