---
description: Triage open GitHub issues. Pulls issues + cross-references PRs, greps codebase for relevant files, prioritizes. Read-only — produces a report, not changes.
agent: build
---

Triage open GitHub issues for SQLPilot. Pure analysis, no code changes.

## What this does

1. Runs `scripts/issues-review.sh` — pulls open issues + open PRs, caches to `.opencode/cache/issues-review.json`
2. Cross-references: which issues have WIP PRs? (`Closes #N` / `Fixes #N` in PR bodies)
3. Loads the cache, embodies `.opencode/agent/issue-reviewer.md`
4. For each issue, greps `src/` + `src-tauri/` to ground relevant files
5. Synthesizes per-issue: type, severity, area, approach, effort
6. Stores digest to memory (if cognee MCP available — optional, silently skipped if not)
7. Returns top 3 prioritized recommendations

## When to invoke

- Morning review: check overnight issue inflow
- Before sprint/milestone planning
- "What should we work on?"
- Backlog growing and needs triage
- After a release — verify no new critical bugs landed

## Invocation

```
/reviewissues                  # full triage of all open issues
/reviewissues 175              # deep-dive on one issue
```

Or run directly:

```bash
bash scripts/issues-review.sh             # refresh cache + print path
bash scripts/issues-review.sh --stats     # summary stats only
bash scripts/issues-review.sh --fresh     # force cache refresh
```

Cache is gitignored at `.opencode/cache/`. Re-runs within 1h use the cache. Override TTL with `ISSUES_REVIEW_CACHE_TTL=0` or pass `--fresh`.

## Pre-flight (script enforces, aborts on fail)

- `gh` CLI installed + authenticated
- `jq` installed
- Inside a git repo

## Output

Terse report. Skips Summary block at low N (≤3). Top 3 recommendations at end. No code changes.

## Failure modes

| Symptom                | Cause                      | Fix                                               |
| ---------------------- | -------------------------- | ------------------------------------------------- |
| "gh not authenticated" | gh auth expired            | `gh auth login`                                   |
| "jq not installed"     | missing dep                | `brew install jq` / `apt install jq`              |
| Cache missing          | first run                  | script auto-creates                               |
| cognee MCP absent      | optional memory            | skipped silently, report still produced           |
| Cache stale >1h        | long session, fresh issues | pass `--fresh` or set `ISSUES_REVIEW_CACHE_TTL=0` |

## See also

- `scripts/issues-review.sh` — data-pull script (deterministic, no LLM)
- `.opencode/agent/issue-reviewer.md` — agent definition (embodied on invocation)
- `/review-prs` — companion: review open PRs
- `.opencode/AGENTS.md` — Self-Dispatch protocol

## Config

- `SQLPILOT_REPO_DIR` — repo location (default: pwd)
- `ISSUES_REVIEW_CACHE_TTL` — cache TTL in sec (default: 3600)
- Cache file: `.opencode/cache/issues-review.json` (gitignored)
