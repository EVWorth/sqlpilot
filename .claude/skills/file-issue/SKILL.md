---
name: file-issue
description: File a GitHub issue for something wrong found while working on SQLPilot — a failing check, broken test setup, regression, stale comment or doc, CI gap — even when it is outside the current task. Use as soon as you notice the problem, instead of widening the current PR.
---

# File an issue

Anything wrong gets an issue, as soon as you find it, even outside the task at
hand. Don't fix it in the current PR unless it blocks that PR.

## Before filing

Search open and closed issues for a duplicate (`gh issue list --search`, or the
GitHub MCP `search_issues` tool where `gh` isn't available). If one exists, add
what you found as a comment instead.

## Title

Conventional-commit style, naming the symptom: `fix: grid loses edits when
switching tabs`, `ci: browser tests not run on PRs touching src/dev`,
`docs: TESTING_STRATEGY describes a removed E2E suite`.

## Body

```markdown
<One paragraph: what is wrong and who it affects.>

## Reproduce

<The exact command or steps.>

<Its output, trimmed to the part that shows the problem.>

## Cause

<File and line, and why it happens. "Unknown" is fine; say what you ruled out.>

## Fix

<The change you'd make: files, approach, and how to verify it.>
```

Add labels that already exist in the repo (`bug`, `enhancement`,
`documentation`, `ci`, priority labels such as `P1` when the repo uses them).
Link related issues and PRs as `owner/repo#N`.

The repo is public: no names, email addresses, usernames, home-directory paths,
hostnames or tokens in the title, body or pasted output. Replace them with
placeholders such as `$HOME` before posting.

Then carry on with the original task and mention the issue number in your
report.
