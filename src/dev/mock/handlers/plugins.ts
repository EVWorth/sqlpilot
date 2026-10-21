// Tauri's own plugins: the window, the app version, the updater, relaunch.
//
// These are not SQLPilot commands, but the UI calls them through the same
// `invoke`, as `plugin:<name>|<command>`. In a browser there is no window to
// drag or maximise, so the window calls answer as a normal, unmaximised
// window would and otherwise do nothing.

import type { Handlers } from "../router";

const WINDOW_NOOPS = [
  "start_dragging",
  "toggle_maximize",
  "maximize",
  "unmaximize",
  "minimize",
  "close",
  "destroy",
  "set_title",
  "set_focus",
  "show",
  "hide",
];

export const pluginHandlers: Handlers = {
  "plugin:app|version": () => "1.3.0",
  "plugin:app|name": () => "SQLPilot",
  "plugin:app|tauri_version": () => "2.12.3",
  // No update available: the settings screen shows "up to date".
  "plugin:updater|check": () => null,
  "plugin:process|restart": () => {
    window.location.reload();
    return null;
  },
  "plugin:process|exit": () => null,
  "plugin:window|is_maximized": () => false,
  "plugin:window|is_minimized": () => false,
  "plugin:window|is_fullscreen": () => false,
  "plugin:window|is_focused": () => true,
  "plugin:window|is_visible": () => true,
  "plugin:window|title": () => "SQLPilot",
  "plugin:window|scale_factor": () => window.devicePixelRatio,
  "plugin:window|inner_size": () => ({ width: window.innerWidth, height: window.innerHeight }),
  "plugin:window|outer_size": () => ({ width: window.innerWidth, height: window.innerHeight }),
  ...Object.fromEntries(WINDOW_NOOPS.map((cmd) => [`plugin:window|${cmd}`, () => null])),
};
