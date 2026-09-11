import { Check, Download, Palette, Plus, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  BUILT_IN_THEMES,
  contrastRatio,
  isColor,
  MIN_TEXT_CONTRAST,
  serializeTheme,
  slug,
  type Theme,
  THEME_TOKENS,
  TOKEN_LABELS,
} from "../../lib/themes";
import { useSettingsStore } from "../../stores/settingsStore";
import { allThemes, useThemeStore } from "../../stores/themeStore";

/**
 * Choosing, editing, importing and exporting themes.
 *
 * NFR-5.2. There were two themes written into a stylesheet and nothing a user
 * could do about either (#350).
 *
 * The preview is the app. A separate swatch pane would show colours without
 * showing what they do to a dense grid or a code editor, which is the only
 * question worth asking of a theme — so selecting one applies it, and an edit
 * applies as it is typed. Closing without saving puts back what was showing.
 */

export interface ThemeSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/** A copy of a theme, under a new name, for the user to change. */
function derive(from: Theme, name: string): Theme {
  return { id: slug(name), name, base: from.base, colors: { ...from.colors } };
}

export function ThemeSettingsDialog({ isOpen, onClose }: ThemeSettingsDialogProps) {
  const theme = useThemeStore((s) => s.theme);
  const customThemes = useThemeStore((s) => s.customThemes);
  const setTheme = useThemeStore((s) => s.setTheme);
  const saveCustomTheme = useThemeStore((s) => s.saveCustomTheme);
  const deleteCustomTheme = useThemeStore((s) => s.deleteCustomTheme);
  const importTheme = useThemeStore((s) => s.importTheme);
  const preview = useThemeStore((s) => s.preview);
  const showMinimap = useSettingsStore((s) => s.querySettings.showMinimap);
  const setQuerySettings = useSettingsStore((s) => s.setQuerySettings);

  /** The theme being edited, or null when only picking. */
  const [draft, setDraft] = useState<Theme | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // An edit shows on the page as it is typed; abandoning it puts back the
  // theme that was actually chosen.
  useEffect(() => {
    preview(draft);
    return () => preview(null);
  }, [draft, preview]);

  useEffect(() => {
    if (!isOpen) {
      setDraft(null);
      setNotice(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const available = allThemes(customThemes);
  const current = available.find((t) => t.id === theme);

  const handleImport = (file: File) => {
    void file.text().then((text) => {
      const error = importTheme(text);
      setNotice(error ?? `Imported ${file.name}.`);
    });
  };

  const handleExport = (t: Theme) => {
    const blob = new Blob([serializeTheme(t)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${t.id}.sqlpilot-theme.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSave = () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      setNotice("Give the theme a name.");
      return;
    }
    saveCustomTheme(draft);
    setTheme(draft.id);
    setDraft(null);
    setNotice(`Saved ${draft.name}.`);
  };

  const field =
    "h-7 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[80vh] w-[34rem] flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <Palette className="h-4 w-4 text-[var(--color-text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Appearance</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {draft
            ? (
              <ThemeEditor
                draft={draft}
                onChange={setDraft}
                onCancel={() => setDraft(null)}
                onSave={handleSave}
                field={field}
              />
            )
            : (
              <>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Theme
                </p>
                <div className="space-y-1">
                  <ThemeRow
                    name="Follow the system"
                    detail="Dark or light, whichever the OS is set to"
                    selected={theme === "system"}
                    onSelect={() => setTheme("system")}
                  />
                  {available.map((t) => (
                    <ThemeRow
                      key={t.id}
                      name={t.name}
                      detail={t.builtIn ? "Built in" : "Custom"}
                      swatch={t.colors}
                      selected={theme === t.id}
                      onSelect={() => setTheme(t.id)}
                      onEdit={() => setDraft(t.builtIn ? derive(t, `${t.name} copy`) : { ...t })}
                      onExport={() => handleExport(t)}
                      onDelete={t.builtIn ? undefined : () => deleteCustomTheme(t.id)}
                    />
                  ))}
                </div>

                <p className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Editor
                </p>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                  <input
                    type="checkbox"
                    checked={showMinimap}
                    onChange={(e) =>
                      setQuerySettings({
                        ...useSettingsStore.getState().querySettings,
                        showMinimap: e.target.checked,
                      })}
                    className="h-3.5 w-3.5 accent-brand-500"
                  />
                  {
                    /* FR-2.3.7. Off by default — statements are short and the
                      minimap costs width — but that is a preference (#295). */
                  }
                  Show minimap
                </label>

                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => setDraft(derive(current ?? BUILT_IN_THEMES[0], "My theme"))}
                    className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                  >
                    <Plus className="h-3.5 w-3.5" /> New theme
                  </button>
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                  >
                    <Upload className="h-3.5 w-3.5" /> Import
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json"
                    aria-label="Import theme file"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleImport(file);
                      // Cleared so importing the same file twice still fires.
                      e.target.value = "";
                    }}
                  />
                </div>
              </>
            )}

          {notice && (
            <p role="status" className="mt-3 text-[11px] text-[var(--color-text-secondary)]">
              {notice}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ThemeRow({
  name,
  detail,
  swatch,
  selected,
  onSelect,
  onEdit,
  onExport,
  onDelete,
}: {
  name: string;
  detail: string;
  swatch?: Theme["colors"];
  selected: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onExport?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded border px-2 py-1.5 ${
        selected
          ? "border-brand-500 bg-[var(--color-bg-tertiary)]"
          : "border-[var(--color-border)]"
      }`}
    >
      <button
        onClick={onSelect}
        aria-pressed={selected}
        // Named rather than left to its contents: the row also holds Edit,
        // Export and Delete, and "Nord Built in" is not what this button does.
        aria-label={`Use ${name}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {swatch && (
          <span className="flex shrink-0 overflow-hidden rounded border border-[var(--color-border)]">
            {(["bg-primary", "bg-secondary", "accent", "text-primary"] as const).map((token) => (
              <span
                key={token}
                aria-hidden="true"
                className="h-4 w-3"
                style={{ background: swatch[token] }}
              />
            ))}
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-xs text-[var(--color-text-primary)]">{name}</span>
          <span className="block text-[10px] text-[var(--color-text-muted)]">{detail}</span>
        </span>
        {selected && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-brand-400" />}
      </button>
      {onEdit && (
        <button
          onClick={onEdit}
          aria-label={`Edit ${name}`}
          title="Edit — a built-in theme opens as a copy"
          className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <Palette className="h-3.5 w-3.5" />
        </button>
      )}
      {onExport && (
        <button
          onClick={onExport}
          aria-label={`Export ${name}`}
          className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          aria-label={`Delete ${name}`}
          className="rounded p-1 text-[var(--color-text-muted)] hover:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function ThemeEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  field,
}: {
  draft: Theme;
  onChange: (t: Theme) => void;
  onCancel: () => void;
  onSave: () => void;
  field: string;
}) {
  // The one thing taste does not excuse. Warned about rather than blocked:
  // a theme mid-edit is allowed to be unreadable, and being told so is the
  // point.
  const textContrast = contrastRatio(draft.colors["text-primary"], draft.colors["bg-primary"]);
  const unreadable = textContrast < MIN_TEXT_CONTRAST;

  return (
    <>
      <div className="mb-3 flex items-end gap-2">
        <div className="flex-1">
          <label
            htmlFor="theme-name"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
          >
            Name
          </label>
          <input
            id="theme-name"
            type="text"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value, id: slug(e.target.value) })}
            className={field}
          />
        </div>
        <div className="w-36">
          <label
            htmlFor="theme-base"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
          >
            Reads as
          </label>
          <select
            id="theme-base"
            value={draft.base}
            // Not a colour: it drives `color-scheme` and which Monaco theme
            // the editor uses, and getting those wrong is more jarring than
            // any single colour.
            onChange={(e) => onChange({ ...draft, base: e.target.value as Theme["base"] })}
            className={field}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
      </div>

      {unreadable && (
        <p
          role="alert"
          className="mb-2 rounded border border-yellow-600/50 bg-yellow-900/20 p-2 text-[11px] text-yellow-300"
        >
          Text on the background is {textContrast.toFixed(1)}:1. WCAG AA asks for{" "}
          {MIN_TEXT_CONTRAST}:1 — this will be hard to read.
        </p>
      )}

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {THEME_TOKENS.map((token) => (
          <div key={token} className="flex items-center gap-2">
            <input
              type="color"
              id={`color-${token}`}
              value={isColor(draft.colors[token]) ? draft.colors[token].slice(0, 7) : "#000000"}
              onChange={(e) => onChange({ ...draft, colors: { ...draft.colors, [token]: e.target.value } })}
              className="h-6 w-8 shrink-0 cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
            />
            <label
              htmlFor={`color-${token}`}
              className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-secondary)]"
            >
              {TOKEN_LABELS[token]}
            </label>
          </div>
        ))}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded px-3 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          className="rounded bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-500"
        >
          Save theme
        </button>
      </div>
    </>
  );
}
