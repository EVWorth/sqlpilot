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

Both are seeded from `tests/fixtures/sql/`, which the first `just db-up`
copies into a small image per server (`sqlpilot-test-mysql-8`,
`sqlpilot-test-mariadb-11`). `just db-seed` re-applies `seed.sql` to the
running containers; `just db-reset` rebuilds the images and recreates the
containers, which is what picks up a changed seed file. Never point tests at
3306.

Every checkout shares one set of containers: `just db-up` from a second git
worktree starts or reuses the existing ones rather than creating its own. A
reset or `just db-down` from any worktree therefore affects all of them. The
containers mount nothing from a checkout, so they keep starting after the
worktree that created them is removed.

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

`just db-down` removes the containers and their data volumes when you're
done; `just db-up` recreates them from scratch. To pause them and keep the
data, use `docker stop mas-mysql-8 mas-mariadb-11`.
