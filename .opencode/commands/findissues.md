---
description: Scan the codebase for bugs/improvements and create GitHub issues
agent: build
subtask: true
---
Your task is to scan this codebase for bugs, code quality issues, and missing features, then create well-structured GitHub issues for each finding.

**Phase 1 — Scan for problems:**
Systematically inspect the codebase in `src/` and `src-tauri/src/`. Look for:

1. **Potential bugs:**
   - TypeScript errors or unsafe type assertions (`as`, `!`, `any`)
   - Missing error handling in async operations
   - Race conditions in stores (Zustand)
   - Incorrect dependency arrays in hooks
   - null/undefined access without guards
   - Proper cleanup in useEffect hooks
   - Tauri IPC call error handling

2. **Code quality issues:**
   - Missing tests (check `__tests__/` directories against source files)
   - Components with no error boundaries
   - Components with no loading states
   - Large components (>300 lines)
   - Missing accessibility attributes
   - Inconsistent naming patterns
   - Hardcoded strings that should be constants

3. **Missing features:**
   - What does this app do? (SQL client + Tauri desktop app)
   - Compare against what a production SQL client should have
   - Are keyboard shortcuts documented/consistent?
   - Is there undo/redo support?
   - Form validation coverage

**Phase 2 — Create GitHub issues:**
For each finding, create an issue using:
```
gh issue create --title "<title>" --body "<body>" --label "<label>"
```

Each issue should have:
- A descriptive title prefixed with type: `[Bug]`, `[Improvement]`, or `[Feature]`
- A body with:
  - **Location:** exact file path and line number
  - **Current behavior:** what the code does now
  - **Problem:** why it's a problem
  - **Suggested fix:** how to fix it (pseudocode or description)
- Appropriate labels: `bug`, `enhancement`, `good first issue`, etc.
- For `good first issue` — keep the description clear and scoped small

**Phase 3 — Report:**
After creating issues, output a summary:
- Total issues created
- Bugs: X | Improvements: X | Features: X
- Good first issues: X
- Link to each issue on GitHub

Limit to max 15 issues. Focus on quality over quantity. Skip trivial nits about formatting/style unless they are genuine bugs.

IMPORTANT: You ARE allowed to create GitHub issues. You must NOT modify any source files.
