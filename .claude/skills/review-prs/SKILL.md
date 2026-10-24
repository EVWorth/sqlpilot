---
name: review-prs
description: Review an open SQLPilot pull request (or list the agent PRs awaiting review) with the reviewer agent, run the local gates, and produce terse severity-tagged findings and a verdict. Use for "review PR N", "review agent PRs" or a pre-release pass.
argument-hint: "[pr-number]"
---

# Review PRs

One PR at a time. The maintainer makes the final call; never approve, request
changes or merge without their OK, and show the review body first.

## 1. Pick the PR

With `$ARGUMENTS`, review that PR. Without it, list open PRs labelled
`automated` or `needs-review` (`gh pr list --label <label> --state open`, or the
GitHub MCP tools) with number, title, branch, age and file count, and ask
which to review. Skip drafts and Dependabot PRs.

## 2. Get the diff

Check the branch out in a worktree (`git worktree add ../pr-<n> origin/<branch>`)
so your own working tree stays untouched, and diff against its merge base:
`git diff origin/main...HEAD`. If the author left a report file
(`.doc-keeper-report.md` or similar), every change should trace to a finding
in it; a change that doesn't is itself a finding.

## 3. Review

Dispatch the `reviewer` agent with the PR description and the diff. It
reviews against `REVIEW.md` and returns one line per finding:
`L<line>: <emoji> <severity>: <problem>. <fix>.`

Meanwhile run the gates from `AGENTS.md` that the diff touches. CI is the
floor, not the ceiling.

## 4. Output

```
Reviewed owner/repo#<n> — <title>. N findings (X🔴 Y🟠 Z🟡 W🟢 V🔵).

<file>:L<line>: 🔴 bug: <problem>. <fix>.
...
Gates: <what you ran and the result>.
Verdict: ship / iterate / reject.
```

Never approve a PR that disables a gate, removes a test to get green, or
commits a secret or personal information; flag those to the maintainer at
once. Remove the worktree when done.
