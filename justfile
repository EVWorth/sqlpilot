# SQLPilot task runner.
#
# `just` with no arguments lists everything. Toolchains come from mise.toml,
# so `mise install` then `just <task>` gets the pinned Node and Rust rather
# than whatever happens to be on PATH.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Ports the test databases listen on. Referenced by docker-compose.test.yml
# and by the integration tests' connection profiles.
MYSQL_PORT := "13306"
MARIADB_PORT := "13308"
DB_ROOT_PASSWORD := "test_root_password"

# Show the available tasks.
default:
    @just --list --unsorted

# ── Setup ──────────────────────────────────────────────────────────────────

# Install system deps, toolchains, npm packages, git hooks and Playwright.
setup *ARGS:
    ./scripts/setup.sh {{ ARGS }}

# ── Development ────────────────────────────────────────────────────────────

# Run the desktop app (Tauri).
dev:
    npx tauri dev

# Run the browser preview on localhost:1420.
dev-web:
    npx vite --host

# Build the production desktop binary.
build:
    npx tauri build

# ── Testing ────────────────────────────────────────────────────────────────

# Rust unit tests + frontend unit tests. No database required.
test: test-rust test-frontend

# Rust unit tests. No database required — mirrors what CI runs per PR.
test-rust:
    cd src-tauri && cargo test -p mas-core -p mas-export -p mas-admin -p mas-sqlite --verbose

# These are #[ignore]d so the default run stays container-free, which means
# CI only runs them at release time — this is the way to exercise them before
# touching the query executor, connection manager or admin service.
[doc("Rust tests that need a live MySQL/MariaDB. Run `just db-up` first.")]
test-integration:
    cd src-tauri && cargo test -p mas-core -p mas-admin -- --ignored

# Frontend unit tests (Vitest).
test-frontend:
    npx vitest run

# Browser-mode tests (Playwright).
test-browser:
    npm run test:browser

# Everything, including the database integration tests.
test-all: db-up test test-integration

# ── Linting & formatting ───────────────────────────────────────────────────

# Clippy, TypeScript type check, and formatting check.
lint:
    cd src-tauri && cargo clippy -p mas-core -p mas-export -p mas-admin -- -D warnings
    npx tsc --noEmit
    npx dprint check

# actionlint covers syntax, expressions and the shell inside `run:` blocks;
# the script covers the one thing it does not — whether a pinned action SHA
# actually resolves upstream (#534).
[doc("Lint the GitHub Actions workflows and verify every pinned action SHA.")]
lint-workflows:
    actionlint -no-color -oneline
    ./scripts/check-action-pins.sh

# Format Rust and everything dprint owns.
fmt:
    cd src-tauri && cargo fmt --all
    npx dprint fmt

# --features beta-ai so the AI commands are present in the output.
[doc("Regenerate src/lib/bindings.ts from the Rust command definitions.")]
bindings:
    cd src-tauri && cargo test --features beta-ai --test export_bindings

# ── Test databases ─────────────────────────────────────────────────────────
#
# Bind mounts carry :z so the seed files are relabelled for SELinux hosts
# (Fedora and friends) — without it the container cannot read them and the
# database comes up empty, or in MariaDB's case fails to start at all.

# Start MySQL 8 and MariaDB 11, and wait until they actually accept connections.
db-up:
    docker compose -f docker-compose.test.yml up -d mysql-8 mariadb-11
    @just _db-wait mas-mysql-8
    @just _db-wait mas-mariadb-11
    @echo "MySQL 8 ready on {{ MYSQL_PORT }}, MariaDB 11 on {{ MARIADB_PORT }}."

# Waits on health rather than a bare ping: while the seed scripts run, the
# server is a temporary local-only instance that then restarts, and a ping
# answers during that window. Anything connecting on the strength of it meets
# an EOF moments later. The compose healthchecks probe over TCP for the same
# reason — the temporary server does not listen on it.
[doc("Block until a container reports healthy.")]
_db-wait name:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Waiting for {{ name }}..."
    for _ in $(seq 1 90); do
      status=$(docker inspect -f '{{{{ .State.Health.Status }}' {{ name }} 2>/dev/null || echo missing)
      case "$status" in
        healthy) exit 0 ;;
        missing) echo "{{ name }} is not running" >&2; exit 1 ;;
      esac
      sleep 2
    done
    echo "{{ name }} did not become ready in time" >&2
    docker logs --tail 20 {{ name }} >&2 || true
    exit 1

# Stop and remove the test containers.
db-down:
    -docker rm -f mas-mysql-8 mas-mariadb-11 2>/dev/null

# Re-apply the seed fixture to both running containers.
db-seed:
    docker exec -i mas-mysql-8 mysql -u root -p{{ DB_ROOT_PASSWORD }} < tests/fixtures/sql/seed.sql
    docker exec -i mas-mariadb-11 mariadb -u root -p{{ DB_ROOT_PASSWORD }} < tests/fixtures/sql/seed.sql

# Recreate the containers from scratch.
db-reset: db-down db-up

# Generate the self-signed certificates the SSL tests use.
ssl-certs:
    cd tests/fixtures/ssl && bash generate-certs.sh

# ── Release ────────────────────────────────────────────────────────────────

# LEVEL is major, minor or patch. Unlike the Makefile version this takes the
# level as an argument rather than an environment variable.
[doc("Bump the version across package.json, tauri.conf.json and Cargo.toml.")]
bump LEVEL="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{ LEVEL }}" in
      major|minor|patch) ;;
      *) echo "LEVEL must be major, minor or patch (got '{{ LEVEL }}')" >&2; exit 1 ;;
    esac

    current=$(node -p "require('./package.json').version")
    new=$(node -e "
      const [maj, min, pat] = '$current'.split('.').map(Number);
      const bump = { major: [maj + 1, 0, 0], minor: [maj, min + 1, 0], patch: [maj, min, pat + 1] };
      console.log(bump['{{ LEVEL }}'].join('.'));
    ")
    echo "Current version: $current"
    echo "New version:     $new"
    read -p "Proceed? [Y/n] " -r reply
    if [[ -n "$reply" && ! "$reply" =~ ^[Yy]$ ]]; then echo "Cancelled."; exit 0; fi

    node -e "
      const fs = require('fs');
      for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        doc.version = '$new';
        fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
      }
    "
    sed -i "s/^version = \".*\"/version = \"$new\"/" src-tauri/Cargo.toml
    echo "Version bumped to $new."
    echo "Next: git add -A && git commit -m \"chore: bump version to $new\" && git tag v$new"

# ── Housekeeping ───────────────────────────────────────────────────────────

# Remove build output and test artifacts.
clean:
    cd src-tauri && cargo clean
    rm -rf dist coverage playwright-report test-results
