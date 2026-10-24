---
name: findissues
description: Scan the SQLPilot codebase for bugs, code-quality problems and missing features, and file a GitHub issue for each real finding (at most 15). Read-only on source. Use when asked to "find issues", "find bugs" or audit an area.
argument-hint: "[path or area]"
---

# Find issues

Scan for problems and file them. Never modify source files.

Scope: `$ARGUMENTS` if given (a path or an area such as "grid" or
"backup"), otherwise `src/` and `src-tauri/`. For a wide scan, split the
areas across parallel `Explore` agents and verify what they report yourself.

## What to look for

- **Bugs:** unchecked `as`, `!` or `any` (TS) and `unwrap()` (Rust) on real
  paths; async errors dropped or swallowed; races in stores; wrong hook
  dependency arrays or missing effect cleanup; unguarded null access;
  IPC errors not surfaced to the user.
- **Contract drift:** components calling `api.*` directly, camelCase fields
  against snake_case Rust, a mock handler that disagrees with the real command.
- **Quality:** missing tests for exported logic, missing loading or error
  states, components far over 300 lines, missing labels or focus handling,
  comments that no longer match the code.
- **Gaps:** what a production SQL client would be expected to do here and
  doesn't (keyboard access, undo, validation, cancellation).

Skip formatting and taste. Every finding needs a file and line you have read,
and a concrete failure: inputs or steps and what goes wrong.

## File them

Use the `file-issue` skill's format for each finding, at most 15, best first.
Check for duplicates before filing.

## Report

Counts by kind (bugs, improvements, features) and one line per issue with its
link.
