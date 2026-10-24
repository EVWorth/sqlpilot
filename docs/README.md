# SQLPilot Docs

Every document in `docs/`, what it is, and when to read it. User-facing
features are in the root [README.md](../README.md); setup and the PR workflow
are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Reference

| Doc                          | What it is                                                       | Read it when                                           |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| [CI.md](CI.md)               | The workflows, their path filters, and the automation identity   | A CI job did or did not run and you want to know why   |
| [RELEASING.md](RELEASING.md) | The release flow, the release workflow's jobs, and its gotchas   | Cutting a release, or touching `release.yml`           |
| [SECURITY.md](SECURITY.md)   | CSP and its trade-offs, credentials, the agent endpoint, signing | Touching the CSP, capabilities, credentials or signing |

## Design

| Doc                                                            | What it is                                                            | Read it when                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| [design/ARCHITECTURE.md](design/ARCHITECTURE.md)               | Processes, crates, the IPC command surface, storage, error handling   | Touching anything that crosses the IPC boundary or two crates |
| [design/AI_INTEGRATION.md](design/AI_INTEGRATION.md)           | The MCP tool surface, the policy, agent sessions and harness adapters | Working on agent tools, grants, approvals or sessions         |
| [design/TESTING_STRATEGY.md](design/TESTING_STRATEGY.md)       | Test layers, the database containers, and which tests run where       | Writing tests, or wondering why a test did not run in CI      |
| [design/TECH_DECISIONS.md](design/TECH_DECISIONS.md)           | ADRs for the major technology choices, with status                    | Picking new technology, or asking "why X and not Y"           |
| [design/DESIGN_REQUIREMENTS.md](design/DESIGN_REQUIREMENTS.md) | Functional and non-functional requirements with status flags          | Planning a feature, or checking what was promised             |

`ARCHITECTURE.md` section 5 is checked in CI by
[`scripts/check-documented-commands.sh`](../scripts/check-documented-commands.sh):
every command it names must be registered in `src-tauri/src/lib.rs`.

## Assets

[`assets/`](assets/) holds images used by the root README.
