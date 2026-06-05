import { Pencil, Plus, Save, Undo2, Redo2, AlertTriangle } from "lucide-react";

interface EditToolbarProps {
  editMode: boolean;
  onToggleEditMode: () => void;
  pendingCount: number;
  hasChanges: boolean;
  hasPrimaryKey: boolean;
  isSaving: boolean;
  onAddRow: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

export function EditToolbar({
  editMode,
  onToggleEditMode,
  pendingCount,
  hasChanges,
  hasPrimaryKey,
  isSaving,
  onAddRow,
  onSave,
  onDiscard,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: EditToolbarProps) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1">
      <button
        onClick={onToggleEditMode}
        className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
          editMode
            ? "bg-brand-600 text-white"
            : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
        }`}
        title={editMode ? "Exit edit mode" : "Enter edit mode"}
      >
        <Pencil className="h-3 w-3" />
        Edit Mode
      </button>

      {editMode && (
        <>
          <div className="h-4 w-px bg-[var(--color-border)]" />

          <button
            onClick={onAddRow}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <Plus className="h-3 w-3" />
            Add Row
          </button>

          <button
            onClick={onSave}
            disabled={!hasChanges || isSaving}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${
              hasChanges && !isSaving
                ? "bg-green-600 text-white hover:bg-green-700"
                : "cursor-not-allowed text-[var(--color-text-muted)] opacity-50"
            }`}
          >
            <Save className="h-3 w-3" />
            Save Changes{hasChanges ? ` (${pendingCount})` : ""}
          </button>

          <button
            onClick={onDiscard}
            disabled={!hasChanges}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
              hasChanges
                ? "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
                : "cursor-not-allowed text-[var(--color-text-muted)] opacity-50"
            }`}
          >
            <Undo2 className="h-3 w-3" />
            Discard
          </button>

          {onUndo && (
            <button
              onClick={onUndo}
              disabled={!canUndo}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                canUndo
                  ? "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
                  : "cursor-not-allowed text-[var(--color-text-muted)] opacity-50"
              }`}
              title="Undo (Ctrl+Z)"
            >
              <Undo2 className="h-3 w-3" />
              Undo
            </button>
          )}
          {onRedo && (
            <button
              onClick={onRedo}
              disabled={!canRedo}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                canRedo
                  ? "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
                  : "cursor-not-allowed text-[var(--color-text-muted)] opacity-50"
              }`}
              title="Redo (Ctrl+Shift+Z)"
            >
              <Redo2 className="h-3 w-3" />
              Redo
            </button>
          )}

          {!hasPrimaryKey && (
            <div className="ml-2 flex items-center gap-1 rounded bg-amber-900/30 px-2 py-0.5 text-[10px] text-amber-400">
              <AlertTriangle className="h-3 w-3" />
              No primary key detected. Updates may affect multiple rows.
            </div>
          )}
        </>
      )}
    </div>
  );
}
