#!/usr/bin/env bash
# scripts/check-documented-commands.sh
#
# Compare the Tauri commands ARCHITECTURE section 5 documents against the ones
# actually registered in src-tauri/src/lib.rs.
#
# Section 5 declared export_data, import_data and preview_import for a long
# time. None of them were ever implemented, and nothing noticed — a document
# read as a contract for a surface that did not exist (#363). Names are the
# part a reader relies on and the part a script can check, so this checks
# those.
#
# Usage:
#   scripts/check-documented-commands.sh          # report and fail on drift
#   scripts/check-documented-commands.sh --list   # just print both sides

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
arch="$root/docs/design/ARCHITECTURE.md"
lib="$root/src-tauri/src/lib.rs"

# Documented: `async fn name(` inside section 5's rust blocks, minus the ones
# the section itself marks as not implemented. Marking one is an accepted
# answer — the section is then describing a plan rather than claiming a
# surface — so those are listed at the end rather than failing the check.
section="$(awk '/^## 5\./,/^## 6\./' "$arch")"

documented="$(
  echo "$section" | grep -oE 'async fn [a-z0-9_]+' | awk '{print $3}' | sort -u
)"

# A name is "planned" when NOT IMPLEMENTED appears in the block above it.
planned="$(
  echo "$section" |
    awk '/NOT IMPLEMENTED/ { flag = 1 }
         /^async fn / { if (flag) { sub(/\(.*/, "", $3); print $3 }; flag = 0 }' |
    sort -u
)"
documented="$(comm -23 <(echo "$documented") <(echo "$planned"))"

# Registered: the invoke_handler list. Deduplicated because the handler is
# declared twice, once per feature configuration, and the module path is
# stripped — commands live under commands::, commands::sqlite:: and
# commands::ai::, and a first version of this script reported every AI command
# as missing because it only knew the first two.
registered="$(
  grep -oE 'commands::([a-z0-9_]+::)*[a-z0-9_]+,' "$lib" |
    sed 's/,$//' | awk -F':' '{print $NF}' | sort -u
)"

if [ "${1:-}" = "--list" ]; then
  echo "documented in ARCHITECTURE section 5:"
  echo "$documented" | sed 's/^/  /'
  echo "registered in lib.rs:"
  echo "$registered" | sed 's/^/  /'
  exit 0
fi

missing="$(comm -23 <(echo "$documented") <(echo "$registered"))"

if [ -n "$missing" ]; then
  echo "ARCHITECTURE section 5 documents commands that do not exist:" >&2
  echo "$missing" | sed 's/^/  /' >&2
  echo >&2
  echo "Implement them, or amend the section to describe what is there." >&2
  exit 1
fi

echo "Every command documented in ARCHITECTURE section 5 is registered."

if [ -n "$planned" ]; then
  count="$(echo "$planned" | wc -l | tr -d ' ')"
  echo
  echo "$count documented command(s) are marked NOT IMPLEMENTED:"
  echo "$planned" | sed 's/^/  /'
fi

# Undocumented commands are reported without failing. Not every command
# belongs in an architecture overview, and treating that as an error would
# push people to document trivia to get a green tick.
undocumented="$(comm -13 <(echo "$documented") <(echo "$registered"))"
if [ -n "$undocumented" ]; then
  count="$(echo "$undocumented" | wc -l | tr -d ' ')"
  echo
  echo "For information: $count registered command(s) are not described there."
  echo "$undocumented" | sed 's/^/  /'
fi
