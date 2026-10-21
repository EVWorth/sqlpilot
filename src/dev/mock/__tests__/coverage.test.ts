import { describe, expect, it } from "vitest";
import bindingsSource from "../../../lib/bindings.ts?raw";
import { handlers } from "..";

// The mock backend is only useful while it answers everything the UI can
// ask. A command added to the Rust side shows up in the generated bindings;
// without a handler, the screen that uses it fails in the preview with "no
// handler", and nobody notices until they try to review that screen.
const commands = [...bindingsSource.matchAll(/__TAURI_INVOKE(?:<[^>(]*>)?\("([a-z_]+)"/g)].map((m) => m[1]);

describe("mock backend", () => {
  it("finds the commands in the generated bindings", () => {
    // A guard on the guard: a change to how bindings.ts is generated must
    // not turn this into a test that checks nothing.
    expect(commands.length).toBeGreaterThan(50);
  });

  it("has a handler for every backend command", () => {
    const missing = commands.filter((cmd) => !(cmd in handlers));
    expect(missing).toEqual([]);
  });

  it("has no handler for a command that no longer exists", () => {
    const known = new Set(commands);
    const stale = Object.keys(handlers).filter((cmd) => !cmd.startsWith("plugin:") && !known.has(cmd));
    expect(stale).toEqual([]);
  });
});
