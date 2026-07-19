---
description: Run doc-keeper drift sweep on demand. Detects drift between code and docs, applies minimal fixes, opens a PR for review.
agent: build
---

Run the doc-keeper agent for on-demand drift detection.

## What this does

1. Invokes `scripts/doc-keeper-sweep.sh`
2. Script runs doc-keeper agent with drift-detection prompt
3. If drift found: creates branch `doc-keeper/sweep-<timestamp>`, commits, pushes, opens PR
4. If no drift: exits silently, no branch, no PR
5. Returns PR URL when applicable

## When to invoke

- After a major refactor (renamed crates, moved modules, changed ports)
- Before cutting a release (verify README, AGENTS.md, design docs accurate)
- When you suspect drift (e.g., user reports doc claiming X but code does Y)
- After merging a big feature (verify docs mention it)

## Invocation

```bash
bash scripts/doc-keeper-sweep.sh
```

Or use the AI-driven workflow:

```
/doc-keeper            # run sweep with default scope (all docs)
/doc-keeper ARCHITECTURE.md   # limit to one file (manual edit of prompt)
```

## Pre-flight (script enforces, aborts on fail)

- Working tree clean
- On `main` branch
- `gh` CLI installed + authenticated
- No existing open doc-keeper PR (prevents duplicates)
- `git pull --ff-only` succeeds

These guards mean the script is safe to run anytime. Worst case: it skips with a log line.

## Safety

- 2000-line diff guard: aborts if agent makes massive unsolicited rewrites
- Report file required: agent must write `.doc-keeper-report.md` or script aborts
- Agent timeout: 25min hard cap
- Branch-based: never pushes to main directly

## Review protocol (after PR opens)

1. `gh pr list --label automated,documentation --state open`
2. `gh pr checkout <number>`
3. Read `.doc-keeper-report.md` (agent's audit trail)
4. Embody `reviewer` per `.opencode/AGENTS.md` Self-Dispatch protocol
5. Output terse findings (severity emojis, one line each) on PR
6. User approves → merge

Or use `/review-prs` to do all of the above in one command.

## Failure modes

| Symptom                     | Cause                          | Fix                                  |
| --------------------------- | ------------------------------ | ------------------------------------ |
| "Working tree dirty"        | Uncommitted changes            | Commit/stash, retry                  |
| "Not on main"               | On feature branch              | `git checkout main`                  |
| "Open doc-keeper PRs exist" | Prior PR not reviewed          | Review + close prior PR              |
| Agent error / timeout       | API issue, bad prompt          | Check creds, retry, or fix prompt    |
| "Diff > 2000 lines"         | Agent misbehaved               | Investigate branch, fix agent prompt |
| "Missing report file"       | Agent didn't write audit trail | Force agent discipline, retry        |

## See also

- `scripts/doc-keeper-sweep.sh` — the run script (well-commented header)
- `.opencode/agent/doc-keeper.md` — agent definition
- `.opencode/command/review-prs.md` — `/review-prs` review routine
- `.opencode/AGENTS.md` — Self-Dispatch protocol

## Config

Override defaults via env vars:

- `SQLPILOT_REPO_DIR` — repo location (default: `/var/home/elliot/repos/sqlpilot`)
- `DOC_KEEPER_MAX_DIFF_LINES` — diff guard (default: 2000)
- `DOC_KEEPER_AGENT_TIMEOUT` — agent timeout in sec (default: 1500)
- `DOC_KEEPER_BRANCH_PREFIX` — branch name prefix (default: `doc-keeper/sweep`)
- `ANTHROPIC_API_KEY` (or other provider key) — required

Set in your shell env, or pass inline: `DOC_KEEPER_MAX_DIFF_LINES=5000 bash scripts/doc-keeper-sweep.sh`.
