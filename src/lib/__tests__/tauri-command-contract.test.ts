import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the Rust↔JS IPC seam.
 *
 * `tauri-api` is mocked in every other test file, so nothing else notices if a
 * command is renamed in Rust, dropped from the handler list, or invoked from
 * TypeScript under a name that no longer exists — the whole suite stays green
 * and the app breaks at runtime. These tests read both sides and compare.
 *
 * This checks command *names* only. Argument and return shapes are still
 * unverified; that needs generated bindings (tauri-specta), not string
 * matching.
 */

const repoRoot = resolve(__dirname, "../../..");

function frontendCommands(): Set<string> {
  const src = readFileSync(resolve(repoRoot, "src/lib/tauri-api.ts"), "utf8");
  // every call site looks like tauriInvoke<T>("command_name", …) or
  // tauriInvoke("command_name")
  const matches = src.matchAll(/tauriInvoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g);
  return new Set([...matches].map((m) => m[1]));
}

function rustCommands(): Set<string> {
  const src = readFileSync(resolve(repoRoot, "src-tauri/src/lib.rs"), "utf8");
  const start = src.indexOf("generate_handler![");
  expect(start, "generate_handler! block not found in src-tauri/src/lib.rs").toBeGreaterThan(-1);
  const end = src.indexOf("])", start);
  const block = src.slice(start, end);

  // entries are `commands::name,` or `commands::module::name,`, some behind
  // a #[cfg(feature = "…")] attribute on the preceding line
  const matches = block.matchAll(/commands::(?:[a-z0-9_]+::)*([a-z0-9_]+)\s*,/g);
  return new Set([...matches].map((m) => m[1]));
}

describe("Tauri command contract", () => {
  const frontend = frontendCommands();
  const rust = rustCommands();

  it("finds commands on both sides (guards against the regexes silently breaking)", () => {
    // If a refactor changes either file's shape, the parsers could return
    // empty sets and every comparison below would trivially pass.
    expect(frontend.size).toBeGreaterThan(20);
    expect(rust.size).toBeGreaterThan(20);
  });

  it("every command the frontend invokes is registered in Rust", () => {
    const missing = [...frontend].filter((c) => !rust.has(c)).sort();
    expect(
      missing,
      `invoked from tauri-api.ts but absent from generate_handler! — these fail at runtime: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every command Rust registers is reachable from the frontend", () => {
    const unused = [...rust].filter((c) => !frontend.has(c)).sort();
    expect(
      unused,
      `registered in generate_handler! but never invoked — dead command or a missing tauri-api wrapper: ${
        unused.join(", ")
      }`,
    ).toEqual([]);
  });
});
