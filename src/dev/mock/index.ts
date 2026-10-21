// A fake backend, so the UI can run in an ordinary browser with data in it.
//
// Dev only. `main.tsx` installs it before the app loads when the page is
// opened with `?mock` under `just dev-web`, and never in a production build:
// the guard there is `import.meta.env.DEV`, which Vite folds to `false`, so
// this module is not even bundled.
//
// Every backend call goes through `invoke` in the generated bindings, so one
// `mockIPC` callback stands in for all of them. Each command is answered by a
// handler in `handlers/`, keyed by its Rust name. A command with no handler
// fails loudly, in the console and in the UI, rather than returning nothing
// and leaving a screen that looks broken for no visible reason.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { adminHandlers } from "./handlers/admin";
import { agentHandlers } from "./handlers/agent";
import { connectionHandlers } from "./handlers/connections";
import { fileHandlers } from "./handlers/files";
import { historyHandlers } from "./handlers/history";
import { pluginHandlers } from "./handlers/plugins";
import { queryHandlers } from "./handlers/query";
import { schemaHandlers } from "./handlers/schema";
import { sqliteHandlers } from "./handlers/sqlite";
import type { Handlers } from "./router";
import { resetState, type Scenario, scenarioFromUrl } from "./state";

export const handlers: Handlers = {
  ...connectionHandlers,
  ...queryHandlers,
  ...schemaHandlers,
  ...adminHandlers,
  ...fileHandlers,
  ...historyHandlers,
  ...sqliteHandlers,
  ...agentHandlers,
  ...pluginHandlers,
};

export function installMockBackend(scenario: Scenario = scenarioFromUrl(window.location.search)): void {
  resetState(scenario);
  mockWindows("main");
  mockIPC(
    async (cmd, payload) => {
      const handler = handlers[cmd];
      if (!handler) {
        console.error(`[mock backend] no handler for "${cmd}"`, payload);
        throw `The mock backend has no handler for "${cmd}". Add one in src/dev/mock/handlers/.`;
      }
      return handler((payload ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );
  console.info(`[mock backend] installed (scenario: ${scenario})`);
}

/**
 * What a scenario does once the app is on screen.
 *
 * The app never asks the backend which connections are already live, so a
 * connection made only inside the mock would never appear. `connected` goes
 * through the app's own store instead, as a person clicking Connect would.
 */
export function afterRender(scenario: Scenario = scenarioFromUrl(window.location.search)): void {
  if (scenario !== "connected") return;
  void import("../../stores/connectionStore").then(({ useConnectionStore }) =>
    useConnectionStore.getState().connect("profile-local")
  );
}
