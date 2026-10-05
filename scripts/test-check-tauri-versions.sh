#!/usr/bin/env bash
# scripts/test-check-tauri-versions.sh
#
# Tests for check-tauri-versions.sh. Each case builds a minimal
# package-lock.json and Cargo.lock in a temporary repo root and points the
# checker at it.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="$script_dir/check-tauri-versions.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
ok() { printf '  ok   %s\n' "$1"; passed=$((passed + 1)); }
bad() { printf '  FAIL %s\n     %s\n' "$1" "$2"; failed=$((failed + 1)); }

# npm_lock "<pkg>=<ver>" ... → a package-lock.json body
npm_lock() {
  local entries="" sep="" pair
  for pair in "$@"; do
    entries+="$sep\"node_modules/${pair%%=*}\": {\"version\": \"${pair#*=}\"}"
    sep=","
  done
  printf '{"lockfileVersion": 3, "packages": {"": {"name": "app"}%s%s}}' "${entries:+,}" "$entries"
}

# cargo_lock "<crate>=<ver>" ... → a Cargo.lock body
cargo_lock() {
  local pair
  printf 'version = 4\n'
  for pair in "$@"; do
    printf '\n[[package]]\nname = "%s"\nversion = "%s"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\ndependencies = [\n "serde",\n]\n' \
      "${pair%%=*}" "${pair#*=}"
  done
}

# expect <name> <want-exit> <needle> <npm-lock> <cargo-lock>
expect() {
  local name="$1" want="$2" needle="$3" dir="$work/$1" output status
  mkdir -p "$dir/src-tauri"
  printf '%s' "$4" > "$dir/package-lock.json"
  printf '%s' "$5" > "$dir/src-tauri/Cargo.lock"
  output=$(bash "$checker" "$dir" 2>&1) && status=0 || status=$?
  if [[ $status -ne $want ]]; then
    bad "$name" "expected exit $want, got $status: $output"
  elif [[ "$output" != *"$needle"* ]]; then
    bad "$name" "expected the output to mention '$needle', got: $output"
  else
    ok "$name"
  fi
}

echo "check-tauri-versions.sh"

expect "matching pairs pass" 0 "All 2 Tauri package pairs agree" \
  "$(npm_lock @tauri-apps/api=2.11.1 @tauri-apps/plugin-updater=2.12.0)" \
  "$(cargo_lock tauri=2.11.5 tauri-plugin-updater=2.12.3)"

expect "a plugin a minor ahead fails" 1 "@tauri-apps/plugin-updater is 2.12.0 but the tauri-plugin-updater crate is 2.11.0" \
  "$(npm_lock @tauri-apps/api=2.11.1 @tauri-apps/plugin-updater=2.12.0)" \
  "$(cargo_lock tauri=2.11.5 tauri-plugin-updater=2.11.0)"

expect "the api package pairs with the tauri crate" 1 "@tauri-apps/api is 2.12.0 but the tauri crate is 2.11.5" \
  "$(npm_lock @tauri-apps/api=2.12.0)" \
  "$(cargo_lock tauri=2.11.5)"

expect "patch differences are fine" 0 "All 1 Tauri package pairs agree" \
  "$(npm_lock @tauri-apps/plugin-shell=2.3.9)" \
  "$(cargo_lock tauri-plugin-shell=2.3.6)"

expect "a package with no crate is skipped" 0 "All 1 Tauri package pairs agree" \
  "$(npm_lock @tauri-apps/api=2.11.1 @tauri-apps/cli=2.12.0)" \
  "$(cargo_lock tauri=2.11.5)"

expect "a crate named like a prefix is not confused" 1 "tauri-plugin-shell crate is 2.3.6" \
  "$(npm_lock @tauri-apps/plugin-shell=2.4.0)" \
  "$(cargo_lock tauri-plugin-shell-extra=2.4.0 tauri-plugin-shell=2.3.6)"

expect "nested copies are ignored" 0 "All 1 Tauri package pairs agree" \
  "$(npm_lock @tauri-apps/api=2.11.1 some-dep/node_modules/@tauri-apps/api=1.6.0)" \
  "$(cargo_lock tauri=2.11.5)"

expect "no pairs at all fails" 2 "found no Tauri package pairs" \
  "$(npm_lock react=19.3.0)" \
  "$(cargo_lock serde=1.0.0)"

echo ""
echo "$passed passed, $failed failed"
[[ $failed -eq 0 ]]
