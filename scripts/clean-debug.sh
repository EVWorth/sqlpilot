#!/usr/bin/env bash
# scripts/clean-debug.sh
#
# Free disk taken by Rust debug builds without a full `cargo clean`.
#
# Incremental caches and old test executables are most of the debug
# directory under the target directory (CARGO_TARGET_DIR when set, else
# src-tauri/target), and both are rebuilt on demand. Cloud sessions run
# out of disk on them (CLAUDE.md, Cloud sessions); a full clean costs a
# cold rebuild of every dependency, which this avoids.
#
# Usage:
#   scripts/clean-debug.sh            # incremental caches + test binaries > 100 MB
#   scripts/clean-debug.sh --all-deps # also every test binary, whatever its size
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Where Cargo puts its builds: a worktree pointed at a shared target directory
# through CARGO_TARGET_DIR would otherwise clean a directory nothing builds in.
debug="${CARGO_TARGET_DIR:-$root/src-tauri/target}/debug"

if [ ! -d "$debug" ]; then
  echo "Nothing to clean: $debug does not exist."
  exit 0
fi

before=$(du -sk "$debug" | cut -f1)

rm -rf "$debug/incremental"

# Test and binary executables sit in deps/ next to the .rlib/.rmeta files
# dependents need; only the executables are safe to drop.
size_filter=(-size +100M)
[ "${1:-}" = "--all-deps" ] && size_filter=()
if [ -d "$debug/deps" ]; then
  find "$debug/deps" -maxdepth 1 -type f -executable "${size_filter[@]}" -delete
fi

after=$(du -sk "$debug" | cut -f1)
echo "Freed $(((before - after) / 1024)) MB from $debug."
