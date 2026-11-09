#!/usr/bin/env bash
# scripts/bump-version.sh
#
# Set the app's version everywhere it is recorded:
#   package.json, package-lock.json (the app's own two fields only),
#   src-tauri/tauri.conf.json, src-tauri/Cargo.toml and the app's entry in
#   src-tauri/Cargo.lock.
#
# Usage:
#   scripts/bump-version.sh <new-version> [--stage]
#
# --stage also `git add`s the files it changed. Commitizen's pre-bump hook
# passes it, so the bump commit carries all five files (see .cz.toml).
#
# Releases are cut by CI (.github/workflows/auto-release.yml), which runs this
# through commitizen. `just bump` calls it too, for fixing version drift.

set -euo pipefail

new="${1:-}"
stage=false
[ "${2:-}" = "--stage" ] && stage=true

if ! [[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <major.minor.patch> [--stage] (got '$new')" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

NEW="$new" node -e '
  const fs = require("fs");
  const v = process.env.NEW;
  for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.version = v;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  }
  // The lockfile records the app version twice. Set just those two fields:
  // an npm install would re-resolve, and an npm older than the one that
  // wrote the lockfile drops fields it does not know (#777).
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  lock.version = v;
  lock.packages[""].version = v;
  fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
'

sed -i.bak "s/^version = \".*\"/version = \"$new\"/" src-tauri/Cargo.toml
rm -f src-tauri/Cargo.toml.bak

# Moves only the workspace members' entries in Cargo.lock; no dependency
# changes. Offline first; a fresh CI runner has no registry cache, and then
# cargo needs the index to check the lockfile, though it still changes
# nothing else.
(
  cd src-tauri
  cargo update --workspace --offline --quiet 2>/dev/null ||
    cargo update --workspace --quiet
)

if $stage; then
  git add package.json package-lock.json src-tauri/tauri.conf.json \
    src-tauri/Cargo.toml src-tauri/Cargo.lock
fi

echo "Version set to $new."
