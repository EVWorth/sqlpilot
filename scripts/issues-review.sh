#!/usr/bin/env bash
# scripts/issues-review.sh
#
# Pull all open GitHub issues + cross-referenced PRs into a single cache file.
# Feeds the issue-reviewer agent. Pure bash + gh + jq. No LLM calls.
#
# Cache schema (.opencode/cache/issues-review.json):
# {
#   "repo": "owner/name",
#   "generated_at": "2026-07-19T12:34:56Z",
#   "open_issues": [{number, title, body, labels, author, createdAt, updatedAt, comment_count}, ...],
#   "open_prs": [{number, title, body, headRefName, author, createdAt}, ...],
#   "linked_prs": [{pr, title, refs: [issue_numbers]}, ...],
#   "summary": {open_count, by_label, oldest_age_days, linked_to_open_pr}
# }
#
# Usage:
#   scripts/issues-review.sh           # use cache if <TTL, else refresh
#   scripts/issues-review.sh --fresh   # force refresh
#   scripts/issues-review.sh --stats   # print summary only, don't refresh
#
# Exit codes:
#   0  - success (cache fresh or refreshed)
#   1  - pre-flight failure (gh/jq missing, not authed)
#   2  - fetch failed
#   3  - cache write failed

set -euo pipefail

REPO_DIR="${SQLPILOT_REPO_DIR:-$(pwd)}"
CACHE_DIR="${REPO_DIR}/.opencode/cache"
CACHE_FILE="${CACHE_DIR}/issues-review.json"
CACHE_TTL_SEC="${ISSUES_REVIEW_CACHE_TTL:-3600}"
LOG_PREFIX="[issues-review]"
LIMIT=500

log()  { printf '%s %s %s\n' "$LOG_PREFIX" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
err()  { printf '%s ERROR: %s\n' "$LOG_PREFIX" "$*" >&2; }
die()  { err "$*"; exit "${2:-1}"; }

usage() {
  sed -n '2,20p' "$0"
  exit 0
}

# --- Parse args ---
FRESH=false
STATS_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=true ;;
    --stats) STATS_ONLY=true ;;
    --help|-h) usage ;;
    -*) die "Unknown flag: $arg" 1 ;;
    *) die "Unexpected arg: $arg" 1 ;;
  esac
done

# --- Pre-flight ---
[ -d "$REPO_DIR/.git" ] || die "Not a git repo: $REPO_DIR" 1
command -v gh >/dev/null || die "gh CLI not installed" 1
command -v jq >/dev/null || die "jq not installed (brew install jq / apt install jq)" 1
gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login)" 1

mkdir -p "$CACHE_DIR"

# --- Cache check (unless --fresh) ---
if [ "$FRESH" = false ] && [ -f "$CACHE_FILE" ]; then
  MTIME=$(stat -c %Y "$CACHE_FILE" 2>/dev/null || stat -f %m "$CACHE_FILE")
  AGE=$(($(date +%s) - MTIME))
  if [ "$AGE" -lt "$CACHE_TTL_SEC" ]; then
    log "Cache fresh (${AGE}s old, TTL ${CACHE_TTL_SEC}s). Use --fresh to force refresh."
    if [ "$STATS_ONLY" = true ]; then
      jq -r '
        "Open issues: \(.summary.open_count)",
        "By label: \(.summary.by_label | tojson)",
        "Linked to open PR: \(.summary.linked_to_open_pr)",
        "Oldest issue age: \(.summary.oldest_age_days // "n/a") days"
      ' "$CACHE_FILE"
    else
      printf '%s\n' "$CACHE_FILE"
    fi
    exit 0
  fi
  log "Cache stale (${AGE}s > TTL ${CACHE_TTL_SEC}s). Refreshing."
fi

# --- Fetch ---
log "Fetching open issues + PRs (limit ${LIMIT})..."
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)" || die "gh repo view failed" 2

OPEN_ISSUES_JSON="$(gh issue list --state open --limit "$LIMIT" \
  --json number,title,body,labels,author,createdAt,updatedAt,comments 2>&1)" \
  || die "gh issue list failed" 2

OPEN_PRS_JSON="$(gh pr list --state open --limit "$LIMIT" \
  --json number,title,body,headRefName,author,createdAt 2>&1)" \
  || die "gh pr list failed" 2

log "Fetched $(echo "$OPEN_ISSUES_JSON" | jq 'length') issues + $(echo "$OPEN_PRS_JSON" | jq 'length') PRs."

# --- Build linked_prs: for each open PR, extract #N refs from body, filter to open issues ---
LINKED_PRS_JSON="$(echo "$OPEN_PRS_JSON" | jq --argjson issues "$OPEN_ISSUES_JSON" '
  ($issues | map(.number)) as $nums |
  map(
    . as $pr |
    ([((.body // "") | scan("#(\\d+)"; "g")) | .[] | .[0] | tonumber] | unique) as $refs |
    ($refs | map(select(. as $n | $nums | index($n))) ) as $matches |
    select($matches | length > 0) |
    {pr: .number, title: .title, refs: $matches}
  )
')"

# --- Assemble final cache ---
FINAL_JSON="$(jq -n \
  --arg repo "$REPO" \
  --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson issues "$OPEN_ISSUES_JSON" \
  --argjson prs "$OPEN_PRS_JSON" \
  --argjson linked "$LINKED_PRS_JSON" \
  '
  {
    repo: $repo,
    generated_at: $generated_at,
    open_issues: $issues,
    open_prs: $prs,
    linked_prs: $linked,
    open_issues: ($issues | map(. + {comment_count: (.comments | length)})),
    summary: {
      open_count: ($issues | length),
      by_label: (
        $issues
        | map(.labels[].name)
        | group_by(.)
        | map({name: .[0], value: length})
        | from_entries
      ),
      oldest_age_days: (
        if ($issues | length) > 0
        then ((now - ($issues | min_by(.createdAt).createdAt | fromdateiso8601)) / 86400 | floor)
        else null
        end
      ),
      linked_to_open_pr: (
        $linked | map(.refs[]) | unique | length
      )
    }
  }
')"

# --- Write cache atomically ---
TMP="$(mktemp "${CACHE_DIR}/issues-review.XXXXXX.json")"
trap 'rm -f "$TMP"' EXIT
echo "$FINAL_JSON" > "$TMP" || die "Cache write failed: $TMP" 3
mv "$TMP" "$CACHE_FILE" || die "Cache mv failed: $CACHE_FILE" 3
trap - EXIT

log "Cached → $CACHE_FILE"

# --- Output ---
if [ "$STATS_ONLY" = true ]; then
  jq -r '
    "Open issues: \(.summary.open_count)",
    "By label: \(.summary.by_label | tojson)",
    "Linked to open PR: \(.summary.linked_to_open_pr)",
    "Oldest issue age: \(.summary.oldest_age_days // "n/a") days"
  ' "$CACHE_FILE"
else
  printf '%s\n' "$CACHE_FILE"
fi
exit 0
