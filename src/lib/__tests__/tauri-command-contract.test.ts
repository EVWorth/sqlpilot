import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Finds Rust commands that nothing on the frontend calls.
 *
 * This test used to check both directions between `tauri-api.ts` and
 * `generate_handler!`. Half of that is now enforced by construction: the
 * command list is generated into `bindings.ts` from Rust, `tauri-api` calls
 * `commands.*`, so a command that disappears from Rust fails `tsc` rather
 * than a string comparison — and CI regenerates the bindings to catch a stale
 * checked-in file.
 *
 * What generation does *not* catch is the opposite: a command registered in
 * Rust that no longer has a caller. That is dead code plus dead surface area
 * on the IPC boundary, so it is still worth flagging.
 */

const repoRoot = resolve(__dirname, "../../..");

/** Command names exported by the generated bindings. */
function generatedCommands(): Set<string> {
  const src = readFileSync(resolve(repoRoot, "src/lib/bindings.ts"), "utf8");
  const start = src.indexOf("export const commands = {");
  expect(start, "commands object not found in generated bindings").toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("\n}", start));
  return new Set([...block.matchAll(/^\t([a-zA-Z0-9]+):/gm)].map((m) => m[1]));
}

/** Commands actually reached from the api wrapper. */
function calledCommands(): Set<string> {
  const src = readFileSync(resolve(repoRoot, "src/lib/tauri-api.ts"), "utf8");
  return new Set([...src.matchAll(/commands\.([a-zA-Z0-9]+)\(/g)].map((m) => m[1]));
}

describe("Tauri command surface", () => {
  const generated = generatedCommands();
  const called = calledCommands();

  it("parses both sides (guards against the regexes silently matching nothing)", () => {
    expect(generated.size).toBeGreaterThan(20);
    expect(called.size).toBeGreaterThan(20);
  });

  it("every command Rust exposes has a caller", () => {
    const orphaned = [...generated].filter((c) => !called.has(c)).sort();
    expect(
      orphaned,
      `exposed on the IPC boundary but never called — remove the command or add a tauri-api wrapper: ${
        orphaned.join(", ")
      }`,
    ).toEqual([]);
  });
});
