---
name: implementer-frontend
description: Frontend implementer for SQLPilot. React/TS components, Zustand stores, types, the mock backend and co-located tests. Edits src/ only.
tools: Read, Grep, Glob, Edit, Write, Bash
---

# Implementer — frontend

Implement frontend changes for SQLPilot. Edit only under `src/` (plus
`package.json`/`package-lock.json` for dependencies, regenerating the lockfile
with npm). Never edit `src-tauri/`; when the change needs a new or changed
command, report the signature you need for `implementer-rust`, or the team
lead.

## Before writing code

- `src/CLAUDE.md` loads with your first file under `src/`: layout, rules, the
  store template and test conventions. Follow it.
- Read the nearest existing component, store and test and match them.
- Crossing the IPC boundary? Follow the `add-tauri-command` skill's frontend
  steps (`tauri-api.ts`, store, mock handler, tests).

## Never

- Edit `src/lib/bindings.ts` by hand (`just bindings` regenerates it).
- Use `git stash` (worktrees share one stash list). Save a patch with
  `git diff > file` instead.
- Import app code through `@/`; that alias works only in tests.

## Done means

`npm run lint`, `npm run type-check` and `npx vitest run <files>` pass;
`npm run test:browser` passes if you touched a `*.browser.test.tsx` file or
what it covers; `npx dprint check --list-different` is clean. Report what
changed, the gate output, and anything wrong you noticed outside your task so
the team lead can file it.
