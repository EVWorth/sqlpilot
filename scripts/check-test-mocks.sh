#!/usr/bin/env bash
#
# Fail when a `vi.mock` specifier points at a file that does not exist.
#
# Vitest does not error on an unresolvable `vi.mock` path — it silently does
# nothing, and the suite runs against the real module. A test file in
# `src/components/<area>/__tests__/` needs `../../../stores/x` to reach
# `src/stores/x`; the natural-looking `../../stores/x` lands in
# `src/components/stores/x`, which is nowhere.
#
# Nine of these had accumulated across five files before anything caught one,
# and it was caught by accident: a new test failed in a way that made no sense
# until the real store's generated id turned up in the output (#594). Nothing
# else was going to find them, because a suite running against real modules
# mostly still passes.
#
# Only relative specifiers are checked. Bare ones are packages, and `vi.mock`
# on a package is ordinary.

set -euo pipefail

cd "$(dirname "$0")/.."

failures=0
checked=0

while IFS= read -r file; do
  # One specifier per line, from `vi.mock("…")` and `vi.mock(import("…"))`.
  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    case "$spec" in
      .*) ;;
      *) continue ;;  # a package, not a path
    esac

    checked=$((checked + 1))
    dir="$(dirname "$file")"
    # No realpath --relative-to here: the target need not exist yet, which is
    # the whole point.
    target="$(cd "$dir" && printf '%s/%s' "$(pwd)" "$spec")"

    found=""
    for candidate in "$target" "$target.ts" "$target.tsx" "$target.js" \
      "$target/index.ts" "$target/index.tsx"; do
      if [ -e "$candidate" ]; then
        found="$candidate"
        break
      fi
    done

    if [ -z "$found" ]; then
      echo "  ${file}"
      echo "    vi.mock(\"${spec}\") resolves to nothing"
      failures=$((failures + 1))
    fi
  done < <(grep -oE 'vi\.mock\(\s*(import\(\s*)?"[^"]+"' "$file" |
    grep -oE '"[^"]+"' | tr -d '"')
# -type f first: `__screenshots__` directories are named after the test file
# that produced them, so a bare -name would hand grep a directory.
done < <(find src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \
  -o -name '*.spec.ts' -o -name '*.spec.tsx' \) | sort)

if [ "$failures" -gt 0 ]; then
  echo
  echo "${failures} vi.mock path(s) resolve to nothing."
  echo "Vitest ignores these silently, so the suite runs against the real module."
  exit 1
fi

echo "All ${checked} relative vi.mock path(s) resolve."
