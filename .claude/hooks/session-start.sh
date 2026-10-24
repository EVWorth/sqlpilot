#!/usr/bin/env bash
# Session setup for Claude Code cloud containers. Does nothing elsewhere.
#
# The container's Playwright expects a newer headless shell than the
# Chromium it ships, so the browser tests need CHROMIUM_PATH pointed at the
# full browser (vitest.browser.config.ts and scripts/ui-snapshots.mjs read it).
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -x /opt/pw-browsers/chromium ]; then
  echo "export CHROMIUM_PATH=/opt/pw-browsers/chromium" >> "$CLAUDE_ENV_FILE"
fi
