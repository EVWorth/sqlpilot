#!/usr/bin/env bash
# scripts/setup.sh
#
# Bootstrap a SQLPilot dev environment from scratch. Idempotent — safe to
# re-run after pulling, and it will only do the work that is still missing.
#
# Installs, in order:
#   1. Tauri's Linux system libraries (apt, needs sudo)
#   2. mise, if absent, then Node + Rust per mise.toml
#   3. npm dependencies (npm ci) and lefthook's git hooks
#   4. Playwright's chromium, needed by `npm run test:browser`
#
# Flags:
#   --skip-system   don't touch apt (for non-Debian hosts or CI)
#   --skip-mise     use whatever node/rust are already on PATH
#   -h, --help
set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_SYSTEM=0
SKIP_MISE=0
for arg in "$@"; do
  case "$arg" in
    --skip-system) SKIP_SYSTEM=1 ;;
    --skip-mise) SKIP_MISE=1 ;;
    -h | --help)
      sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$1" >&2; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$1" >&2
  exit 1
}

# ── 0. version files are the source of truth; mise.toml restates them ──
# mise only reads .node-version / rust-toolchain.toml when idiomatic version
# files are explicitly enabled, so the values are duplicated in mise.toml.
# Catch them drifting apart rather than letting the two quietly disagree.
check_versions_agree() {
  local node_file rust_file node_mise rust_mise
  node_file="$(tr -d '[:space:]' < .node-version)"
  rust_file="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)"
  node_mise="$(sed -n 's/^node *= *"\(.*\)"/\1/p' mise.toml)"
  rust_mise="$(sed -n 's/^rust *= *"\(.*\)"/\1/p' mise.toml)"

  [ "$node_file" = "$node_mise" ] \
    || die ".node-version ($node_file) and mise.toml ($node_mise) disagree"
  [ "$rust_file" = "$rust_mise" ] \
    || die "rust-toolchain.toml ($rust_file) and mise.toml ($rust_mise) disagree"
}
check_versions_agree

# ── 1. Tauri system libraries ──
if [ "$SKIP_SYSTEM" -eq 1 ]; then
  info "skipping system dependencies (--skip-system)"
elif ! command -v apt-get > /dev/null 2>&1; then
  warn "no apt-get — install Tauri's deps by hand (see README) then re-run with --skip-system"
else
  # libayatana-appindicator3-dev, NOT libappindicator3-dev: the latter
  # conflicts with libayatana-appindicator3-1 on Ubuntu 24.04 and aborts
  # the whole transaction, leaving none of these installed.
  info "installing Tauri system dependencies (sudo)"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    build-essential \
    pkg-config \
    libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libssl-dev
fi

# ── 2. mise, then the toolchains it pins ──
if [ "$SKIP_MISE" -eq 1 ]; then
  info "skipping mise (--skip-mise); using node/rust already on PATH"
else
  if ! command -v mise > /dev/null 2>&1; then
    info "installing mise"
    curl -fsSL https://mise.run | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
  command -v mise > /dev/null 2>&1 \
    || die "mise installed but not on PATH — add ~/.local/bin to PATH and re-run"

  info "installing Node + Rust per mise.toml"
  mise install
  # Subsequent commands in THIS script still use the outer shell's PATH, so
  # ask mise to place shims where later steps can see them.
  eval "$(mise activate bash --shims)"
fi

command -v node > /dev/null 2>&1 || die "node not found — run without --skip-mise, or install Node $(cat .node-version)"
command -v cargo > /dev/null 2>&1 || warn "cargo not found — Rust builds and the cargo git hooks will not work"

info "node $(node --version), npm $(npm --version)"
command -v cargo > /dev/null 2>&1 && info "cargo $(cargo --version | cut -d' ' -f2)"

# ── 3. npm dependencies + git hooks ──
info "installing npm dependencies"
npm ci

info "installing git hooks"
npx lefthook install

# ── 4. Playwright browsers for the browser-mode test project ──
# Needs re-running whenever @playwright/test is bumped, otherwise
# `npm run test:browser` fails asking for exactly this.
info "installing Playwright chromium"
npx playwright install --with-deps chromium

cat <<'DONE'

Setup complete.

  make dev            desktop app (Tauri)
  make dev-web        browser preview
  npm run test:unit   unit tests
  npm run test:browser browser-mode tests
  make db-up          MySQL 8 test container

DONE
