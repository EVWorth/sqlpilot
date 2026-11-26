import {
  clampFontSize,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  UI_SCALES,
  useSettingsStore,
} from "../../stores/settingsStore";

/**
 * The Appearance dialog's Editor section: minimap, editor font size and
 * interface scale, and where an editor tab's results are kept.
 */
export function EditorAppearanceSettings() {
  const showMinimap = useSettingsStore((s) => s.querySettings.showMinimap);
  const editorFontSize = useSettingsStore((s) => s.querySettings.editorFontSize);
  const uiScale = useSettingsStore((s) => s.querySettings.uiScale);
  const keepResultsInWebview = useSettingsStore((s) => s.querySettings.keepResultsInWebview);
  const setQuerySettings = useSettingsStore((s) => s.setQuerySettings);

  return (
    <>
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
        {/* FR-2.3.7. Off by default — statements are short and the
              minimap costs width — but that is a preference (#295). */}
        Show minimap
      </label>

      {/* Size, which was not adjustable at all (#837). */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-secondary)]">
          Editor font size
          <input
            type="number"
            min={EDITOR_FONT_SIZE_MIN}
            max={EDITOR_FONT_SIZE_MAX}
            value={editorFontSize}
            onChange={(e) => {
              if (e.target.value === "") return;
              setQuerySettings({
                ...useSettingsStore.getState().querySettings,
                editorFontSize: clampFontSize(Number(e.target.value)),
              });
            }}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-secondary)]">
          Interface scale
          <select
            value={uiScale}
            onChange={(e) =>
              setQuerySettings({
                ...useSettingsStore.getState().querySettings,
                uiScale: Number(e.target.value),
              })}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-brand-500"
          >
            {UI_SCALES.map((scale) => (
              <option key={scale} value={scale}>
                {Math.round(scale * 100)}%
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Ctrl+= and Ctrl+- change the interface scale; Ctrl+0 resets it.
      </p>

      <p className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        Results
      </p>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-secondary)]">
        <input
          type="checkbox"
          checked={keepResultsInWebview}
          aria-describedby="keep-results-in-webview-hint"
          onChange={(e) =>
            setQuerySettings({
              ...useSettingsStore.getState().querySettings,
              keepResultsInWebview: e.target.checked,
            })}
          className="h-3.5 w-3.5 accent-brand-500"
        />
        Load whole results into the window (the older way)
      </label>
      <p id="keep-results-in-webview-hint" className="mt-1 text-xs text-[var(--color-text-muted)]">
        Uses much more memory on large results. Turn on only if something about results stopped working, and report it.
        Applies to queries run from now on.
      </p>
    </>
  );
}
