import { useEffect } from "react";
import { useSettingsStore } from "../stores/settingsStore";

/**
 * Apply the Interface scale setting to the whole window (#837).
 *
 * CSS `zoom` on the root rather than a root font size: much of the interface
 * is sized in px (`text-[10px]`, fixed bar heights), which a rem change would
 * leave as it was. The factor is also published as `--ui-scale` for anything
 * that needs to account for it. At 100% nothing is set at all, so the default
 * renders exactly as before.
 */
export function useUiScale() {
  const scale = useSettingsStore((s) => s.querySettings.uiScale);

  useEffect(() => {
    const root = document.documentElement;
    if (scale === 1) {
      root.style.removeProperty("zoom");
      root.style.removeProperty("--ui-scale");
    } else {
      root.style.setProperty("zoom", String(scale));
      root.style.setProperty("--ui-scale", String(scale));
    }
  }, [scale]);
}
