#!/usr/bin/env bash
# scripts/test-cargo-audit-check.sh
#
# Tests for cargo-audit-check.sh.
#
# The gate's job is to tell "nothing found" from "could not look" (#729), so
# most cases here are ways of not looking: a missing tool, no report, a report
# that does not parse, a stale advisory database. A fake `cargo` on PATH plays
# back a canned `cargo audit --json` report per case, so no network or real
# advisory database is needed.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="$script_dir/cargo-audit-check.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
ok() { printf '  ok   %s\n' "$1"; passed=$((passed + 1)); }
bad() { printf '  FAIL %s\n     %s\n' "$1" "$2"; failed=$((failed + 1)); }

# A bin directory holding every tool on the real PATH except jq, so the
# "jq is missing" case can be run without uninstalling anything.
nojq_bin="$work/nojq-bin"
mkdir -p "$nojq_bin"
IFS=: read -r -a path_dirs <<< "$PATH"
for dir in "${path_dirs[@]}"; do
  [[ -d "$dir" ]] || continue
  for tool in "$dir"/*; do
    name="${tool##*/}"
    if [[ "$name" != jq && ! -e "$nojq_bin/$name" && -x "$tool" ]]; then
      ln -s "$tool" "$nojq_bin/$name"
    fi
  done
done

# Fakes for cargo and cargo-audit: `cargo audit --json` prints $REPORT_FILE.
fake_bin="$work/fake-bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/cargo" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == audit ]] || { echo "fake cargo: only 'audit' is faked" >&2; exit 99; }
cat "$REPORT_FILE"
exit "${AUDIT_EXIT:-0}"
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$fake_bin/cargo-audit"
chmod +x "$fake_bin/cargo" "$fake_bin/cargo-audit"

# Run the checker against report `$2`, with `$3` as the base PATH.
run_case() {
  local name="$1" report="$2" base_path="${3:-$PATH}"
  local dir="$work/$name"
  mkdir -p "$dir/ws"
  printf '%s' "$report" > "$dir/report.json"
  (
    cd "$dir"
    unset GITHUB_STEP_SUMMARY
    REPORT_FILE="$dir/report.json" CARGO_WORKSPACE_DIR=ws \
      PATH="$fake_bin:$base_path" bash "$checker" 2>&1
  )
}

expect_status() {
  local name="$1" want="$2" report="$3" needle="$4" base_path="${5:-$PATH}" output status
  output=$(run_case "$name" "$report" "$base_path") && status=0 || status=$?
  if [[ $status -ne $want ]]; then
    bad "$name" "expected exit $want, got $status: $output"
  elif [[ "$output" != *"$needle"* ]]; then
    bad "$name" "expected the output to mention '$needle', got: $output"
  else
    ok "$name"
  fi
}

today="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
old="2020-01-01T00:00:00Z"

report() { # report <last-updated> <vulnerabilities list> <unmaintained list>
  printf '{"database":{"last-updated":"%s"},"vulnerabilities":{"found":false,"count":0,"list":%s},"warnings":{"unmaintained":%s}}' \
    "$1" "$2" "$3"
}
advisory() { # advisory <id>
  printf '{"advisory":{"id":"%s","package":"pkg","title":"a title"}}' "$1"
}

many_warnings="[$(for i in $(seq 1 80); do advisory "RUSTSEC-0000-$i"; if [[ $i -lt 80 ]]; then printf ','; fi; done)]"

echo "cargo-audit-check.sh"

expect_status "a clean report passes" 0 \
  "$(report "$today" '[]' '[]')" "0 real vulnerabilities"

expect_status "a real vulnerability fails" 1 \
  "$(report "$today" "[$(advisory RUSTSEC-2099-0001)]" '[]')" "RUSTSEC-2099-0001"

expect_status "warnings alone do not fail" 0 \
  "$(report "$today" '[]' "[$(advisory RUSTSEC-2099-0002)]")" "1 non-blocking"

expect_status "more findings than the display shows still passes" 0 \
  "$(report "$today" '[]' "$many_warnings")" "80 non-blocking"

expect_status "jq missing fails" 2 \
  "$(report "$today" '[]' '[]')" "'jq' is not installed" "$nojq_bin"

expect_status "no report fails" 2 \
  "" "did not produce a report"

expect_status "a report that is not JSON fails" 2 \
  "error: failed to fetch advisory database" "did not produce a report"

expect_status "a report whose findings do not parse fails" 2 \
  "$(report "$today" '"not-a-list"' '[]')" "could not parse"

expect_status "a stale advisory database warns" 0 \
  "$(report "$old" '[]' '[]')" "days old"

expect_status "the database age is shown" 0 \
  "$(report "$today" '[]' '[]')" "0 day(s) ago"

echo ""
echo "$passed passed, $failed failed"
[[ $failed -eq 0 ]]
