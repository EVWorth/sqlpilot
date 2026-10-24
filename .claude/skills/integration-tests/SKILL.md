---
name: integration-tests
description: Run SQLPilot's database-backed Rust integration tests against MySQL 8 (port 13306) and MariaDB 11 (port 13308) in Docker. Use before shipping changes to the connection manager, query executor, schema inspector, backup/restore, admin or the MCP tools, or when asked to run integration tests.
---

# Integration tests

These tests are `#[ignore]`d so plain `cargo test` needs no database. CI runs
them only at release time, so run them yourself when you touch the
connection manager, query executor, schema inspector, backup/restore, admin
service or the MCP tools.

## 1. Start the databases

```bash
docker info >/dev/null 2>&1 || (sudo dockerd >/tmp/dockerd.log 2>&1 &)   # cloud: Docker doesn't survive a restart
just db-up        # MySQL 8 on 13306, MariaDB 11 on 13308, waits for healthy
```

Both are seeded from `tests/fixtures/sql/`. `just db-seed` re-applies the
seed; `just db-reset` recreates the containers. Never point tests at 3306.

## 2. Run against both servers

```bash
just test-integration                         # MySQL 8
MAS_TEST_PORT=13308 just test-integration     # MariaDB 11
```

The recipe runs `mas-core`, `mas-admin` and `mas-mcp` with
`--ignored --test-threads=1`. To run one file or test:

```bash
cd src-tauri && cargo test -p mas-core --test paging_offset -- --ignored --test-threads=1
```

In a cloud session, first free disk with `bash scripts/clean-debug.sh` and set
`CARGO_INCREMENTAL=0`. If `just` isn't installed, run the recipe's `cargo test`
line from the `justfile` directly.

## 3. Agent tests (separate)

`just test-agents` runs the live harness tests (`agent_end_to_end`,
`live_claude`, `live_copilot`). They need `just db-up` plus Claude Code or
Copilot installed and logged in, and they spend that account's quota, so run
them only when asked or when changing `mas-agent` or the MCP bridge.

`just db-down` stops the containers when you're done.
