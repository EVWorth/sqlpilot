import { Star, X } from "lucide-react";
import { useState } from "react";
import { useFavoritesStore } from "../../stores/favoritesStore";

interface SaveFavoriteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sql: string;
  connectionName?: string;
  database?: string;
}

export function SaveFavoriteDialog({
  isOpen,
  onClose,
  sql,
  connectionName,
  database,
}: SaveFavoriteDialogProps) {
  const categories = useFavoritesStore((s) => s.categories);
  const addFavorite = useFavoritesStore((s) => s.addFavorite);
  const addCategory = useFavoritesStore((s) => s.addCategory);
  const updateFavorite = useFavoritesStore((s) => s.updateFavorite);

  const [name, setName] = useState("");
  const [category, setCategory] = useState("Uncategorized");
  const [newCategory, setNewCategory] = useState("");
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [description, setDescription] = useState("");
  // The favorite this name already belongs to, once the store has refused the
  // save. Held rather than just a message so the user can overwrite it from
  // here instead of cancelling, renaming and losing the SQL they came to save.
  const [conflictId, setConflictId] = useState<string | null>(null);

  if (!isOpen) return null;

  const reset = () => {
    setName("");
    setCategory("Uncategorized");
    setNewCategory("");
    setShowNewCategory(false);
    setDescription("");
    setConflictId(null);
    onClose();
  };

  // Names the category without creating it: a save that the store refuses
  // should not leave a stray empty category behind. addFavorite registers an
  // unknown category itself; the overwrite path has to ask for it.
  const targetCategory = showNewCategory && newCategory.trim() ? newCategory.trim() : category;

  const handleSave = () => {
    if (!name.trim()) return;

    const result = addFavorite({
      name: name.trim(),
      sql,
      category: targetCategory,
      description: description.trim() || undefined,
      connectionName,
      database,
    });

    // The dialog stays open on a refusal: closing it would discard the SQL
    // along with the name the user still has to change (#332).
    if (!result.ok) {
      setConflictId(result.existingId);
      return;
    }
    reset();
  };

  const handleOverwrite = () => {
    if (!conflictId) return;
    addCategory(targetCategory);
    updateFavorite(conflictId, {
      name: name.trim(),
      sql,
      category: targetCategory,
      description: description.trim() || undefined,
    });
    reset();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && name.trim()) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Star className="h-4 w-4 text-yellow-400" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Save as Favorite
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          {/* Name */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setConflictId(null);
              }}
              placeholder="e.g. Get active users"
              autoFocus
              aria-invalid={conflictId !== null || undefined}
              aria-describedby={conflictId ? "favorite-name-error" : undefined}
              className={`w-full rounded border bg-[var(--color-bg-primary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none ${
                conflictId
                  ? "border-red-500 focus:border-red-500"
                  : "border-[var(--color-border)] focus:border-brand-500"
              }`}
            />
            {conflictId && (
              <p id="favorite-name-error" role="alert" className="mt-1 text-[11px] text-red-400">
                A favorite named &ldquo;{name.trim()}&rdquo; is already in{" "}
                {targetCategory}. Rename it, or overwrite the existing one.
              </p>
            )}
          </div>

          {/* Category */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">
              Category
            </label>
            {showNewCategory
              ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    placeholder="New category name"
                    className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-brand-500"
                  />
                  <button
                    onClick={() => setShowNewCategory(false)}
                    className="rounded px-2 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                  >
                    Cancel
                  </button>
                </div>
              )
              : (
                <div className="flex gap-2">
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500"
                  >
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => setShowNewCategory(true)}
                    className="rounded border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
                  >
                    + New
                  </button>
                </div>
              )}
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">
              Description <span className="text-[var(--color-text-muted)]">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this query do?"
              rows={2}
              className="w-full resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-brand-500"
            />
          </div>

          {/* SQL Preview */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-[var(--color-text-secondary)]">
              SQL Preview
            </label>
            <pre className="max-h-24 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {sql || "(empty)"}
            </pre>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            Cancel
          </button>
          {conflictId && (
            <button
              onClick={handleOverwrite}
              className="rounded border border-red-500/60 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10"
            >
              Overwrite
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!name.trim() || conflictId !== null}
            className="rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save Favorite
          </button>
        </div>
      </div>
    </div>
  );
}
