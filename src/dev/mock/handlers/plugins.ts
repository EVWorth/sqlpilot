// Tauri's own plugins: the window, the app version, the updater, relaunch.
//
// The updater answers by the page's `update=` switch: absent, up to date;
// `available`, a release that downloads in about five seconds; `downloading`,
// one that takes two minutes, to look at the progress; `download-error`, one
// whose download breaks halfway; `error`, a check that fails.
//
// These are not SQLPilot commands, but the UI calls them through the same
// `invoke`, as `plugin:<name>|<command>`. In a browser there is no window to
// drag or maximise, so the window calls answer as a normal, unmaximised
// window would and otherwise do nothing.

import { version as packageVersion } from "../../../../package.json";
import { delay, fail, type Handlers } from "../router";
import { state } from "../state";

/** The running app's version: package.json's, so the mock can't drift from it. */
export const APP_VERSION: string = packageVersion;

/** The version every `update=` mode offers. */
export const UPDATE_VERSION = "1.5.0";

/** Bytes in the mock download, and how long each mode takes over it. */
const UPDATE_BYTES = 18_400_000;
const CHUNKS = 40;

interface ChannelLike {
  id: number;
}

const END = Symbol("end");

/**
 * Send to a `Channel` the way Rust does: numbered messages, then an end
 * marker. The mock IPC registers the channel's callback like any other, so
 * `runCallback` reaches it.
 */
function channelSender(channel: unknown): (message: unknown) => void {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void };
  }).__TAURI_INTERNALS__;
  const id = (channel as ChannelLike | undefined)?.id;
  let index = 0;
  return (message) => {
    if (id === undefined) return;
    internals.runCallback(id, message === END ? { index: index++, end: true } : { index: index++, message });
  };
}

/**
 * `downloadAndInstall`: Started, a Progress per chunk, Finished. How long it
 * takes, and whether it gets there, is the `update=` mode's.
 */
async function downloadAndInstall(args: Record<string, unknown>): Promise<null> {
  const send = channelSender(args.onEvent);
  const mode = state.options.update;
  // `downloading` crawls, so the progress state stays on screen to look at.
  const tick = mode === "downloading" ? 3_000 : 120;
  const chunk = Math.ceil(UPDATE_BYTES / CHUNKS);
  await delay(300);
  send({ event: "Started", data: { contentLength: UPDATE_BYTES } });
  for (let i = 0; i < CHUNKS; i++) {
    await delay(tick);
    if (mode === "download-error" && i === Math.floor(CHUNKS / 2)) {
      send(END);
      fail(
        "error sending request for url (https://objects.githubusercontent.com/release-assets/SQLPilot_1.5.0_amd64.AppImage): "
          + "connection closed before message completed",
      );
    }
    send({ event: "Progress", data: { chunkLength: Math.min(chunk, UPDATE_BYTES - i * chunk) } });
  }
  send({ event: "Finished" });
  send(END);
  return null;
}

/** What `plugin:updater|check` answers for the page's `update=` mode. */
async function checkForUpdate(): Promise<unknown> {
  await delay(400);
  switch (state.options.update) {
    case "none":
      return null;
    case "error":
      return fail("Could not fetch a valid release JSON from the remote");
    default:
      return {
        rid: 1,
        currentVersion: APP_VERSION,
        version: UPDATE_VERSION,
        date: "2026-10-27 09:00:00.0 +00:00:00",
        body: "Faster schema browsing, and the agent panel remembers its width.",
        rawJson: {},
      };
  }
}

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
  "plugin:app|version": () => APP_VERSION,
  "plugin:app|name": () => "SQLPilot",
  "plugin:app|tauri_version": () => "2.12.3",
  // Up to date unless the page asks otherwise with `update=`.
  "plugin:updater|check": () => checkForUpdate(),
  "plugin:updater|download_and_install": (args) => downloadAndInstall(args),
  // `Update.close()` releases the Rust resource; there is none here.
  "plugin:resources|close": () => null,
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
