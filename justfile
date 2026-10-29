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

# Run the browser preview on localhost:1420. Open it with `?mock` for the
# mock backend (src/dev/mock): data in every screen, no Tauri needed.
# `?mock=empty` is a first run, `?mock=connected` starts connected.
dev-web:
    npx vite --host

# Screenshot every screen on the mock backend into ui-snapshots/, for review.
ui-snapshots *ARGS:
    node scripts/ui-snapshots.mjs {{ ARGS }}

# Build the production desktop binary.
build:
    npx tauri build

# ── Testing ────────────────────────────────────────────────────────────────

# Rust unit tests + frontend unit tests. No database required.
test: test-rust test-frontend

# Rust unit tests. No database required — mirrors what CI runs per PR.
#
# Two invocations rather than one. The library crates run all their targets,
# integration tests included. The `sqlpilot` crate runs only its lib: its
# integration tests under `tests/` need a live harness or a database, and one
# of them currently fails to build a TLS client in a full-workspace build
# (see the reqwest/rustls note in CI).
#
# Without the second line the main crate's 58 unit tests — every Tauri command
# handler, and the startup messages — are tested by nothing at all.
test-rust:
    cd src-tauri && cargo test -p mas-agent -p mas-core -p mas-export -p mas-admin -p mas-mcp -p mas-sqlite --verbose
    cd src-tauri && cargo test -p sqlpilot --lib --verbose

# These are #[ignore]d so the default run stays container-free, which means
# CI only runs them at release time — this is the way to exercise them before
# touching the query executor, connection manager or admin service.
#
# One test at a time, as the release gate runs them (release.yml): the suites
# share fixture databases — backup_dump, restore_file, ddl_pool_safety and
# paging_offset each drop and reseed their own — so parallel tests collide on
# them ("database exists", tables vanishing mid-dump) and fail where the
# release run passes.
[doc("Rust tests that need a live MySQL/MariaDB. Run `just db-up` first.")]
test-integration:
    cd src-tauri && cargo test -p mas-core -p mas-admin -p mas-mcp -- --ignored --test-threads=1

# The agent tests talk to a real harness, so they are not in test-integration:
# they need the CLI installed and logged in, and they spend the user's own
# quota. Everything they check is invisible from either side alone — whether a
# model can understand the tools, whether the endpoint answers it, whether the
# policy lets the right things through.
[doc("End-to-end agent tests. Needs `just db-up`, and Copilot or Claude Code logged in.")]
test-agents:
    cd src-tauri && cargo test -p mas-agent -p sqlpilot --test live_copilot --test live_claude --test agent_end_to_end -- --ignored --test-threads=1

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
    cd src-tauri && cargo clippy --workspace --all-targets --all-features -- -D warnings
    npx tsc --noEmit
    npx dprint check
    ./scripts/check-tauri-versions.sh

# actionlint covers syntax, expressions and the shell inside `run:` blocks;
# the script covers the two things it does not — whether a pinned action SHA
# actually resolves upstream (#534), and whether the version comment beside it
# is true (#563).
[doc("Lint the GitHub Actions workflows and verify every pinned action SHA.")]
lint-workflows:
    actionlint -no-color -oneline
    ./scripts/check-action-pins.sh
    ./scripts/test-check-action-pins.sh
    ./scripts/test-cargo-audit-check.sh
    ./scripts/test-check-tauri-versions.sh

# Format Rust and everything dprint owns.
fmt:
    cd src-tauri && cargo fmt --all
    npx dprint fmt

[doc("Regenerate src/lib/bindings.ts from the Rust command definitions.")]
bindings:
    cd src-tauri && cargo test --test export_bindings

# ── Test databases ─────────────────────────────────────────────────────────
#
# The seed scripts are built into the MySQL and MariaDB images rather than
# bind-mounted, so the shared containers depend on no checkout's path (#903).

# Start MySQL 8 and MariaDB 11, and wait until they actually accept connections.
#
# Every checkout shares the one set of containers (the compose file pins the
# project name). --no-recreate starts existing ones as they are, so a second
# worktree, whose build context is its own path, never replaces the
# containers, and their data, under the first (#895). After changing the
# compose file or a seed file, `just db-reset` applies it.
db-up:
    docker compose -f docker-compose.test.yml up -d --no-recreate mysql-8 mariadb-11
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

# Recreate the containers from scratch, rebuilding the seeded images first.
db-reset: db-down
    docker compose -f docker-compose.test.yml build mysql-8 mariadb-11
    @just db-up

# Generate the self-signed certificates the SSL tests use.
ssl-certs:
    cd tests/fixtures/ssl && bash generate-certs.sh

# ── Release ────────────────────────────────────────────────────────────────

# LEVEL is major, minor or patch, given as an argument.
[doc("Bump the version in package.json, tauri.conf.json, Cargo.toml and both lockfiles.")]
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
      // The lockfile records the app's own version twice. Set just those
      // two fields: an npm install would re-resolve, and an npm older than
      // the one that wrote the lockfile drops fields it does not know (#777).
      const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
      lock.version = '$new';
      lock.packages[''].version = '$new';
      fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
    "
    sed -i "s/^version = \".*\"/version = \"$new\"/" src-tauri/Cargo.toml
    # Moves only the app's own entry in Cargo.lock; no other crate changes.
    (cd src-tauri && cargo update -p sqlpilot --offline --quiet)
    echo "Version bumped to $new."
    echo "Next: open a release PR with the bump; tag v$new on its merge commit (.claude/skills/release/SKILL.md)."

# ── Housekeeping ───────────────────────────────────────────────────────────

# Remove build output and test artifacts.
clean:
    cd src-tauri && cargo clean
    rm -rf dist coverage playwright-report test-results

# Free disk from debug builds (incremental caches, big test binaries) without
# a full clean. Pass --all-deps to drop every test binary.
clean-debug *ARGS:
    bash scripts/clean-debug.sh {{ ARGS }}
