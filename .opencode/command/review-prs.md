---
description: List open agent PRs, check one out, embody reviewer, output terse review findings with severity emojis. Team-lead's daily review routine.
agent: build
---

Review open agent-produced PRs. Team-lead's daily review routine — embody the `reviewer` agent per Self-Dispatch protocol.

## Inputs

- `$ARGUMENTS` — optional PR number. If empty, list all open PRs with `automated` or `needs-review` label.

## Process

### 1. Discover PRs

```bash
# If no PR number given:
gh pr list --label automated --state open --json number,title,author,createdAt,headRefName
gh pr list --label needs-review --state open --json number,title,author,createdAt,headRefName

# If PR number given:
gh pr view <number> --json number,title,body,files,headRefName,baseRefName
```

Present findings:

```
PRs awaiting review: N

#<num> — <title>
  author: <author>
  branch: <branch>
  age: <days since createdAt>
  files: <file count>
  labels: <labels>
```

### 2. Read .opencode/agent/reviewer.md and embody

Per `.opencode/AGENTS.md` "Team-Lead Self-Dispatch": read the agent's prompt first, adopt its output format strictly.

```
L<line>: <emoji> <severity>: <problem>. <fix>.
```

Em-dash severity emojis:

- 🔴 `bug` — definite bug, blocks merge
- 🟠 `risk` — likely bug, conditional on usage
- 🟡 `style` — convention violation, non-blocking
- 🟢 `nit` — taste preference
- 🔵 `q` — question
- 🟣 `praise` — good call

### 3. Check out PR

```bash
gh pr checkout <number>
```

### 4. Read agent's report (if present)

```bash
# Doc-keeper leaves .doc-keeper-report.md
# Other agents may leave their own report files
ls .opencode-report*.md .doc-keeper-report.md 2>/dev/null
```

Every code change should be traceable to a finding in the report. Mismatch = finding.

### 5. Review diff vs main

```bash
git diff main...HEAD
git diff --stat main...HEAD
```

For each file changed:

- **Doc changes:** verify drift finding exists in report, fix matches the claim, no new drift
- **Code changes:** verify implementation matches the issue/PR description, no type holes, no convention violations
- **Config changes:** verify gates still pass, no lockfile drift
- **Dependency changes:** verify version pin, no breaking changes, dep-age gate respected

### 6. Run local gates (if applicable)

```bash
# Doc changes:
npx dprint check

# Frontend changes:
npm run lint && npm run type-check

# Rust changes:
cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings

# Version drift check (always):
make -n bump patch   # dry-run, just verify makefile parses
```

### 7. Output review

```
Reviewed PR #<num> — <title>.

N findings (X🔴 Y🟠 Z🟡 W🟢 V🔵 U🟣).

L<line>: 🔴 bug: <problem>. <fix>.
L<line>: 🟡 drift: report says X but code shows Y.
L<line>: 🟡 style: <convention violation>. <fix>.
L<line>: 🔵 q: <question for author>.
L<line>: 🟣 praise: <good call>.

Verdict: ship / iterate / reject

Recommended actions:
- [ ] <action 1>
- [ ] <action 2>
```

### 8. Apply review to PR (with user approval)

```bash
# Approve:
gh pr review <number> --approve --body "<review body>"

# Request changes:
gh pr review <number> --request-changes --body "<review body>"

# Comment (neutral, no approval/rejection):
gh pr review <number> --comment --body "<review body>"
```

Don't run `gh pr review` without explicit user OK. Show the proposed body first.

### 9. Return to main

```bash
git checkout main
git pull
```

## When to Use

- **Daily morning:** review any overnight agent work (doc-keeper nightly, etc.)
- **After user mentions "PR ready":** focused review of specific PR
- **Before merging a release:** final pass on all open agent PRs

## When NOT to Use

- User-authored PRs without agent labels (use normal PR review)
- PRs that are still in draft (`gh pr list --state draft`)
- Dependabot PRs (review pattern is different — dep-age gate, security audit)

## Output Style

Terse chat. The PR review body itself stays structured and professional — it's a professional artifact other humans may read.

## Conventions

- One PR at a time. Don't batch multiple PRs into one review.
- Cite line numbers from the actual diff, not from main.
- If agent's report is missing or incomplete, flag as 🟠 — agent should always write audit trail.
- If changes are good but minor nits, approve with comments — don't block.
- If changes are wrong, request-changes with specific fix instructions.
- If changes are dangerous (secret leak, gate disabled, etc.), request-changes immediately and flag to user out-of-band.

## Sacred Rules (review)

1. **Never approve without reading the diff.** Trust + verify.
2. **Never approve a change that disables a gate.** Even with explanation.
3. **Never approve if report is missing.** Forces agent discipline.
4. **Never request changes without a concrete fix suggestion.** Critique without proposal = noise.
5. **Always re-run local gates if changes touch code or configs.** CI is the floor, not the ceiling.

## Related

- `.opencode/agent/reviewer.md` — review agent definition (embody this)
- `.opencode/AGENTS.md` — Self-Dispatch protocol
- `.opencode/ops/nightly-doc-keeper.md` — doc-keeper review specifics
