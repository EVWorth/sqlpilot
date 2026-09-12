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
# Three checks, deliberately separate:
#   - Shape (offline, deterministic). A ref that is not exactly 40 hex chars is
#     rejected. This alone would have caught the bug above, with no network.
#   - Existence (needs the API). Resolves each pin through
#     `gh api repos/OWNER/REPO/commits/SHA`. Skipped when gh is unavailable or
#     unauthenticated, so the shape check still runs locally.
#   - Agreement (needs the API). The trailing `# v1.2.3` comment is the only
#     thing a human reads when reviewing a bump; if it disagrees with the SHA,
#     the review is being done against a claim nothing verifies (#563).
#
#     A comment naming a **tag** must match the pin exactly: a tag is a fixed
#     point, so anything else is a false claim. A comment naming a **branch**
#     — `# stable` for dtolnay/rust-toolchain, say — is checked for ancestry
#     instead, because a branch moves and a pin is deliberately behind it.
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
# The pin and whatever comment follows it, so the two can be compared. A line
# without a comment yields an empty second field.
mapfile -t uses < <(
  grep -rhoE '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*[^[:space:]]+([[:space:]]*#[^\n]*)?' "$workflows_dir" |
    sed -E 's/.*uses:[[:space:]]*//' |
    sed -E 's/[[:space:]]*#[[:space:]]*/\t/' |
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

# Resolve a tag to the commit it points at, following an annotated tag's
# object to the commit it wraps. Fails when the tag does not exist.
resolve_tag() {
  local repo="$1" tag="$2" type sha ref
  ref=$(gh api "repos/$repo/git/ref/tags/$tag" --jq '.object.type + " " + .object.sha' 2>/dev/null) || return 1
  type="${ref%% *}"
  sha="${ref##* }"
  if [[ "$type" == "tag" ]]; then
    # Annotated: one more hop to the commit.
    gh api "repos/$repo/git/tags/$sha" --jq .object.sha 2>/dev/null || return 1
  else
    printf '%s\n' "$sha"
  fi
}

# Whether `sha` is on `branch` — its head, or anywhere in its history. The
# comparison is from the branch's side, so an older pin reads as "behind".
sha_is_on_branch() {
  local repo="$1" branch="$2" sha="$3" status
  gh api "repos/$repo/git/ref/heads/$branch" --jq .object.sha >/dev/null 2>&1 || return 2
  status=$(gh api "repos/$repo/compare/$branch...$sha" --jq .status 2>/dev/null) || return 1
  [[ "$status" == "identical" || "$status" == "behind" ]]
}

failed=0
for entry in "${uses[@]}"; do
  ref="${entry%%$'\t'*}"
  comment=""
  [[ "$entry" == *$'\t'* ]] && comment="${entry#*$'\t'}"
  # Only the first word of the comment: "v1.2.3 (pinned by hand)" is a version
  # with a note after it.
  version="${comment%% *}"

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

  if [[ "$check_existence" == false ]]; then
    echo "ok(shape) $action@$sha"
    continue
  fi

  if ! gh api "repos/$repo/commits/$sha" --jq .sha >/dev/null 2>&1; then
    echo "UNKNOWN   $action@$sha — no such commit in $repo"
    failed=1
    continue
  fi

  # A version comment is not required — some pins are to a branch head that
  # was never tagged — but one that is there has to be true.
  if [[ -z "$version" ]]; then
    echo "ok        $action@$sha (no version comment)"
    continue
  fi

  if tagged=$(resolve_tag "$repo" "$version"); then
    if [[ "$tagged" == "$sha" ]]; then
      echo "ok        $action@$sha # $version"
    else
      echo "MISMATCH  $action@$sha — the comment says $version, which is ${tagged:0:12}"
      failed=1
    fi
    continue
  fi

  # Not a tag. Some actions are pinned to a commit on a moving branch, and
  # naming the branch is the honest comment for that.
  if sha_is_on_branch "$repo" "$version" "$sha"; then
    echo "ok        $action@$sha # $version (branch)"
  else
    case $? in
      2) echo "NO REF    $action@$sha — the comment says $version, and $repo has no such tag or branch" ;;
      *) echo "MISMATCH  $action@$sha — the comment says $version, and this commit is not on that branch" ;;
    esac
    failed=1
  fi
done

exit "$failed"
