#!/usr/bin/env bash
# scripts/check-action-pins.sh
#
# Verify every `uses:` in .github/workflows names an action pinned to a full
# 40-character commit SHA, and that the SHA actually exists upstream.
#
# The motivating bug (#534): dprint-update.yml carried
# peter-evans/create-pull-request@5e9f0e25d8c7b97b5d1de33e3308a46f7bb5f04ae,
# which is 41 characters and matches no commit. GitHub resolves actions before
# a job starts, so the workflow died in seconds with no step ever running — and
# because it was a weekly cron, it failed that way for months unnoticed.
#
# Two checks, deliberately separate:
#   - Shape (offline, deterministic). A ref that is not exactly 40 hex chars is
#     rejected. This alone would have caught the bug above, with no network.
#   - Existence (needs the API). Resolves each pin through
#     `gh api repos/OWNER/REPO/commits/SHA`. Skipped when gh is unavailable or
#     unauthenticated, so the shape check still runs locally.
#
# Usage:
#   scripts/check-action-pins.sh              # both checks
#   scripts/check-action-pins.sh --offline    # shape only, no API calls
#
# Exit codes:
#   0  - every pin is well-formed (and resolves, unless skipped)
#   1  - at least one pin is malformed or unresolvable

set -euo pipefail

offline=false
[[ "${1:-}" == "--offline" ]] && offline=true

workflows_dir=".github/workflows"
[[ -d "$workflows_dir" ]] || { echo "no $workflows_dir directory here" >&2; exit 1; }

# Local composite actions (./.github/actions/foo) have no upstream SHA to pin,
# and Docker refs are versioned differently. Neither is in scope.
mapfile -t uses < <(
  grep -rhoE '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*[^[:space:]#]+' "$workflows_dir" |
    sed -E 's/.*uses:[[:space:]]*//' |
    grep -vE '^(\.|docker://)' |
    sort -u
)

if [[ ${#uses[@]} -eq 0 ]]; then
  echo "no external actions referenced — nothing to check"
  exit 0
fi

check_existence=false
if [[ "$offline" == false ]] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  check_existence=true
else
  echo "note: skipping upstream resolution (no authenticated gh); checking pin shape only"
fi

failed=0
for ref in "${uses[@]}"; do
  action="${ref%@*}"
  sha="${ref##*@}"

  if [[ "$ref" != *@* ]]; then
    echo "UNPINNED  $ref — no ref at all"
    failed=1
    continue
  fi

  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "MALFORMED $action@$sha — expected 40 hex characters, got ${#sha}"
    failed=1
    continue
  fi

  # owner/repo, dropping any sub-path (owner/repo/path/to/action@sha).
  repo=$(cut -d/ -f1,2 <<<"$action")

  if [[ "$check_existence" == true ]]; then
    if gh api "repos/$repo/commits/$sha" --jq .sha >/dev/null 2>&1; then
      echo "ok        $action@$sha"
    else
      echo "UNKNOWN   $action@$sha — no such commit in $repo"
      failed=1
    fi
  else
    echo "ok(shape) $action@$sha"
  fi
done

exit "$failed"
