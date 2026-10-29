// Shared setup for the mock backend's tests: install it as the page would,
// and call commands the way the generated bindings do.

import { invoke } from "@tauri-apps/api/core";
import { clearMocks } from "@tauri-apps/api/mocks";
import { vi } from "vitest";
import { installMockBackend } from "..";

/** Install the mock for a URL's query string, e.g. `?mock=connected&fail=connect`. */
export function install(search = "?mock"): void {
  clearMocks();
  window.history.replaceState(null, "", `/${search}`);
  vi.spyOn(console, "info").mockImplementation(() => {});
  installMockBackend();
}

/** A command, answered by the installed mock. */
export function call<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>(cmd, args);
}

/** The rejection a command fails with. Fails the test if it succeeds. */
export async function rejection(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  try {
    await invoke(cmd, args);
  } catch (e) {
    return e;
  }
  throw new Error(`${cmd} succeeded; expected it to fail`);
}

/** Await a command under fake timers, running the clock until it settles. */
export async function settle<T>(pending: Promise<T>, ms = 15_000): Promise<T> {
  // Attached now, so a rejection is not reported as unhandled while the
  // clock runs.
  const outcome = pending.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  const r = await outcome;
  if (!r.ok) throw r.error;
  return r.value;
}
