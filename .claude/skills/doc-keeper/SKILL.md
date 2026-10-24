---
name: doc-keeper
description: Run a documentation drift sweep for SQLPilot — compare docs/, README, CONTRIBUTING and AGENTS.md against the code, apply minimal fixes and open a PR. Use after a refactor or big feature, before a release, or when a doc is suspected wrong.
argument-hint: "[doc path]"
---

# Doc-keeper sweep

## Locally, with the Claude Code CLI signed in

```bash
bash scripts/doc-keeper-sweep.sh
```

The script refuses to run on a dirty tree, off `main`, without an
authenticated `gh`, or while a doc-keeper PR is already open. It runs
`claude -p --agent doc-keeper`, requires the agent to write
`.doc-keeper-report.md`, aborts on a diff over 2000 lines
(`DOC_KEEPER_MAX_DIFF_LINES`), and opens a PR on a `doc-keeper/sweep-*`
branch. No drift means no branch and no PR. Other settings are in the
script's header.

## In a session (including cloud)

Dispatch the `doc-keeper` agent in its own worktree, scoped to `$ARGUMENTS`
if given, otherwise all docs. Ask for the report it writes for the script:
each drift found (doc says X, code says Y, with file and line) and the fix.
Commit its changes on the session branch and open the PR yourself.

## Review

Review the PR with the `review-prs` skill. Every change should trace to a
finding in the report.
