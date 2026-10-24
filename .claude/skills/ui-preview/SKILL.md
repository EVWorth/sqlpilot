---
name: ui-preview
description: See or screenshot the SQLPilot UI without the desktop app, using the in-browser mock backend (?mock) and `just ui-snapshots`. Use to check a UI change visually, review a screen, or produce screenshots for a PR or UX review.
---

# UI preview with the mock backend

The desktop app needs a Tauri window, but the UI runs in a plain browser
against `src/dev/mock/`, which answers every backend command with fixture data.

## Interactive

```bash
just dev-web      # Vite on http://localhost:1420 (run in the background)
```

| URL                | Starts                                |
| ------------------ | ------------------------------------- |
| `/?mock`           | populated, with saved connections     |
| `/?mock=empty`     | first run, nothing saved              |
| `/?mock=connected` | already connected to a fixture server |

Drive it with Playwright (`require('playwright')`; in a cloud container
`chromium.launch()` needs no options) and take screenshots of the states you
changed, in both themes when colors are involved.

## Every screen at once

```bash
just ui-snapshots                          # all screens into ui-snapshots/
just ui-snapshots --only 01-first-run,02-connections --theme dark
```

The script (`scripts/ui-snapshots.mjs`) starts its own dev server. Set
`CHROMIUM_PATH` if Playwright's bundled Chromium is missing.

## When the mock is wrong

A screen that says "no handler" or shows data the real backend never returns
means the mock is out of date. Fix the handler in `src/dev/mock/handlers/`;
`src/dev/mock/__tests__/coverage.test.ts` keeps the handler set in step with
the generated bindings. The preview is for layout and flow. It has no native
window chrome and no real database, so confirm behaviour with tests.
