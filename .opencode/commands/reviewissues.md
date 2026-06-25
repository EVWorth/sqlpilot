---
description: Review open GitHub issues and suggest implementation approaches
agent: build
subtask: true
---

Fetch all open issues from the current GitHub repository. For each issue:

1. Run `gh issue list --state open --limit 50 --json number,title,labels,createdAt` to get the issue list.
2. For each issue, run `gh issue view <number> --json title,body,labels,comments` to get full details.

Then, for each issue, do the following:

**Classify the issue:**

- Type: bug, feature, enhancement, or question
- App area: which part of the app it affects (e.g., editor, admin, connection, schema, AI, grid, backup, import/export, layout, settings, authentication)
- Severity: critical, high, medium, low

**Find relevant code:**
Search the codebase in `src/` for files that are likely involved. Use the issue title and body to guide your search. Look at:

- Component files in `src/components/<area>/`
- Store files in `src/stores/` (connectionStore, editorStore, resultStore, etc.)
- Type definitions in `src/types/`
- Rust backend code in `src-tauri/src/` if the issue involves native functionality

Present a complete report with this structure:

# Issue Review Report — <today's date>

## Summary

- Total open issues: X
- Bugs: X | Features: X | Enhancements: X
- Critical: X | High: X | Medium: X | Low: X

## Issues

### #<number>: <title>

- **Type:** bug/feature/enhancement
- **Severity:** critical/high/medium/low
- **Labels:** <labels>
- **App Area:** <area>
- **Description:** <summary of what the issue is about>

**Relevant Files:**

- `src/components/<area>/<file>.tsx` — <why it's relevant>
- `src/stores/<store>.ts` — <why it's relevant>

**Suggested Approach:**
<concrete implementation suggestions — describe what to change and where, but DO NOT modify files>

**Effort Estimate:** small / medium / large

---

## Recommendations

List the top 3 issues you recommend tackling first, with rationale.

IMPORTANT: Do NOT modify any files. This is an analysis-only task.
