---
name: reviewissues
description: Triage SQLPilot's open GitHub issues into a prioritized report — type, severity, area, grounded files, approach and effort per issue, plus a recommended order. Read-only. Use for "what should we work on", backlog triage, or a deep-dive on one issue.
argument-hint: "[issue-number]"
---

# Review issues

Produces a report; changes nothing.

## 1. Get the data

```bash
bash scripts/issues-review.sh          # cache to .claude/cache/issues-review.json (1h TTL)
bash scripts/issues-review.sh --fresh  # force a refresh
```

The script needs `gh` (authenticated) and `jq`. Where `gh` isn't available, as
in cloud sessions, fetch open issues and open PRs with the GitHub MCP tools
and write the same file yourself, following the schema in the script's header
(`open_issues`, `open_prs`, `linked_prs`; the summary block is optional).

## 2. Triage

Dispatch the `issue-reviewer` agent with the cache path and `$ARGUMENTS` (an
issue number means a deep-dive on that one issue). It greps the code to ground
each issue, classifies type, severity, area and effort, and ends with a
recommended order.

## 3. Report

Relay its report. Check a sample of its "relevant files" claims before passing
them on. If it found something wrong that has no issue, use the `file-issue`
skill.
