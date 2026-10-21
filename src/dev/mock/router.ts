// The shape every mock handler file exports.
//
// One handler per backend command, keyed by the command's Rust name — the
// same string `src/lib/bindings.ts` passes to `invoke`. Arguments arrive as
// the object bindings.ts builds (camelCase keys, as Tauri sends them).

export type Args = Record<string, unknown>;
export type Handler = (args: Args) => unknown | Promise<unknown>;
export type Handlers = Record<string, Handler>;

/**
 * Fail a command the way the real backend does.
 *
 * The generated bindings turn a rejected `invoke` into `{ status: "error" }`
 * only when the rejection is not an `Error`; an `Error` is rethrown as a
 * crash. The Rust side rejects with a string or a structured payload, so a
 * mock must too.
 */
export function fail(error: string | Record<string, unknown>): never {
  throw error;
}

/** Wait like a real round trip would, so loading states are visible. */
export function delay(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
