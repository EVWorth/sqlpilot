#!/usr/bin/env bash
# scripts/doc-keeper-sweep.sh
#
# Run the doc-keeper agent for drift detection. If drift found, open a PR.
# Designed for on-demand invocation via `/doc-keeper` slash command or directly.
#
# Exit codes:
#   0  - success (with or without drift)
#   1  - pre-flight failure (dirty tree, not on main, etc.)
#   2  - agent invocation failed
#   3  - post-flight failure (missing report, runaway diff, push/PR failed)

set -euo pipefail

# --- Config (overridable via env) ---
REPO_DIR="${SQLPILOT_REPO_DIR:-/var/home/elliot/repos/sqlpilot}"
BRANCH_PREFIX="${DOC_KEEPER_BRANCH_PREFIX:-doc-keeper/sweep}"
MAX_DIFF_LINES="${DOC_KEEPER_MAX_DIFF_LINES:-2000}"
AGENT_TIMEOUT_SEC="${DOC_KEEPER_AGENT_TIMEOUT:-1500}"
LOG_PREFIX="[doc-keeper]"
REPORT_FILE=".doc-keeper-report.md"

# --- Helpers ---
log()  { printf '%s %s %s\n' "$LOG_PREFIX" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
err()  { printf '%s ERROR: %s\n' "$LOG_PREFIX" "$*" >&2; }
die()  { err "$*"; exit "${2:-1}"; }

cleanup() { rm -f "${PROMPT_FILE:-}"; }
trap cleanup EXIT

# --- Pre-flight ---
[ -d "$REPO_DIR" ]            || die "Repo dir not found: $REPO_DIR" 1
[ -d "$REPO_DIR/.git" ]       || die "Not a git repo: $REPO_DIR" 1
command -v gh   >/dev/null    || die "gh CLI not installed" 1
command -v npx  >/dev/null    || die "npx not installed (need Node.js)" 1
gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login)" 1

cd "$REPO_DIR"

if [ -n "$(git status --porcelain)" ]; then
  err "Working tree dirty. Aborting to avoid stomping user edits."
  err "Commit/stash your changes or run manually after."
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  die "Not on main (on $CURRENT_BRANCH). Aborting." 1
fi

# --- Avoid PR spam ---
EXISTING_PRS="$(gh pr list --label automated,documentation --state open --json number --jq 'length' 2>/dev/null || echo 0)"
if [ "${EXISTING_PRS:-0}" -gt 0 ]; then
  log "Open doc-keeper PRs exist (${EXISTING_PRS}). Skipping to avoid spam."
  log "Review or close existing PRs, then re-run."
  exit 0
fi

# --- Pull latest ---
log "Pulling latest main..."
git pull --ff-only || die "git pull failed (maybe main has unpushed local commits?)" 1

# --- Build prompt ---
PROMPT_FILE="$(mktemp -t doc-keeper-prompt.XXXXXX.md)"
cat > "$PROMPT_FILE" <<EOF
# Doc-Keeper On-Demand Sweep

Triggered: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Repo: ${REPO_DIR}

## Agent Definition

Read and embody: \`.opencode/agent/doc-keeper.md\`.

## Mission

1. Detect drift between code and docs (ports, paths, crate list, command sigs, feature counts, etc.)
2. Apply MINIMAL fixes only — smallest change to bring doc back in line with code.
3. Write full report to \`.doc-keeper-report.md\` at repo root.
4. Do NOT modify code, workflows, or non-doc files.
5. Exit 0 regardless of whether changes were made.

## Constraints

- No marketing prose, no new sections without clear drift signal.
- No deletions without explicit drift justification.
- All changes must reference a specific drift finding in the report.
- Run \`npx dprint fmt\` before exiting if any markdown was modified.

## Output

If drift found:
- Edit files in place
- Write structured report to \`.doc-keeper-report.md\` with: scope, findings (🔴 wrong / 🟡 drifted), fixes applied, files touched

If no drift:
- Write \`.doc-keeper-report.md\` with single line: \`No drift detected.\`
- Do not modify any other files
EOF

# --- Run agent ---
# opencode `run` flags (verified via `opencode run --help`):
#   --agent <name>   pick the agent prompt from .opencode/agent/
#   --auto           auto-approve tool calls (no per-tool prompt)
#   <prompt>         first positional arg, the task/instructions
# `--prompt-file` and `--auto-approve` do not exist on `opencode run`.
log "Running doc-keeper agent (timeout: ${AGENT_TIMEOUT_SEC}s)..."
if ! timeout "$AGENT_TIMEOUT_SEC" npx --yes opencode-ai@latest run \
    --agent doc-keeper \
    --auto \
    "$(cat "$PROMPT_FILE")" 2>&1; then
  die "Agent invocation failed or timed out" 2
fi

log "Agent completed."

# --- Format (belt-and-suspenders) ---
if [ -n "$(git status --porcelain | grep -E '\.(md|mdx|markdown)$' || true)" ]; then
  log "Running dprint fmt on markdown changes..."
  npx dprint fmt || true
fi

# --- Check for changes ---
if [ -z "$(git status --porcelain)" ]; then
  log "No drift detected. No PR needed."
  exit 0
fi

log "Drift detected. Files changed:"
git status --short | sed "s/^/${LOG_PREFIX}   /"

# --- Verify report exists ---
[ -f "$REPORT_FILE" ] || die "Agent made changes but did not write ${REPORT_FILE}" 3

# --- Guard against runaway diff ---
# Count insertions + deletions (not insertions only) and include untracked
# new files via `git add -A` + `git diff --cached`. Reset the index after so
# the later commit step picks up files cleanly.
git add -A
DIFF_LINES="$(git diff --cached --shortstat | awk '{print $4+$6}' || echo 0)"
DIFF_LINES="${DIFF_LINES:-0}"
git reset HEAD > /dev/null
if [ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]; then
  die "Diff ${DIFF_LINES} lines exceeds guardrail (${MAX_DIFF_LINES}). Manual review required." 3
fi
log "Diff size OK: ${DIFF_LINES} lines (max ${MAX_DIFF_LINES})"

# --- Create branch + PR ---
TS="$(date -u +%Y%m%d-%H%M%S)"
BRANCH="${BRANCH_PREFIX}-${TS}"

log "Creating branch ${BRANCH}..."
git checkout -b "$BRANCH"
git config user.name "doc-keeper-bot"
git config user.email "doc-keeper-bot@users.noreply.github.com"

git add -A
git commit \
  -m "docs: doc-keeper sweep ${TS}" \
  -m "Automated drift detection. See .doc-keeper-report.md for findings." \
  -m "Triggered on $(hostname) via /doc-keeper or scripts/doc-keeper-sweep.sh."

log "Pushing branch..."
git push origin "$BRANCH" || die "git push failed" 3

# --- Build PR body ---
REPORT="$(cat "$REPORT_FILE")"
DIFF_STAT="$(git diff --stat main...HEAD)"

PR_BODY="$(cat <<EOF
## Doc-Keeper Sweep — ${TS}

Automated drift detection. Branch: \`${BRANCH}\`. Host: \`$(hostname)\`.

### Report

${REPORT}

### Diff Stat

\`\`\`
${DIFF_STAT}
\`\`\`

### Review Checklist (team-lead embodies reviewer)

- [ ] Each 🔴/🟡 finding in report has matching code change in diff
- [ ] No new drift introduced (agent didn't make things worse)
- [ ] No secrets, certs, or config values in diff
- [ ] \`npx dprint check\` passes locally
- [ ] AGENTS.md consistency (if touched, verify team-lead self-dispatch still accurate)
- [ ] No unrelated reformatting or mass rewrites

### Generated by

- Run script: \`scripts/doc-keeper-sweep.sh\`
- Agent: \`.opencode/agent/doc-keeper.md\`
- Command: \`/doc-keeper\` (slash command wrapper)
EOF
)"

log "Creating PR..."
gh pr create \
  --base main \
  --head "$BRANCH" \
  --title "docs: doc-keeper sweep ($(date -u +%Y-%m-%d))" \
  --body "$PR_BODY" \
  --label "documentation" \
  --label "automated" \
  --label "needs-review" \
  || die "gh pr create failed" 3

log "PR created for branch ${BRANCH}. Done."
exit 0