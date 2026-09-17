#!/usr/bin/env bash
# CLAUDE.md §4.2 for gate-labelled issues: every labelled gate needs a test or eval
# fixture, added or modified since <base-ref>, that declares that gate —
#   Vitest:       // @gate query output
#   JSON fixture: "gates": ["output"]
# Called by verify.sh with the issue's gate names; tested offline in gate-fixtures.test.ts.
set -euo pipefail

base=${1:?usage: gate-fixtures.sh <base-ref> [gate…]}
shift
(( $# )) || exit 0

cd "$(git rev-parse --show-toplevel)"

known=" resolution query output "
declared=" "
failed=0

# Content comes from HEAD, not the working tree, so this checks exactly what was committed.
changed=$(git diff --name-only --diff-filter=ACMR "$base" HEAD)
while IFS= read -r file; do
  case $file in
    *.test.ts)
      names=$(git show "HEAD:$file" | sed -nE 's#^[[:space:]]*//[[:space:]]*@gate[[:space:]]+(.*)$#\1#p') ;;
    evals/fixtures/*.json)
      if ! names=$(git show "HEAD:$file" | jq -r '(.gates // []) | .[]' 2>/dev/null); then
        echo "✗ $file isn't valid JSON with a \"gates\" array" >&2
        failed=1
        continue
      fi ;;
    *) continue ;;
  esac
  for name in $names; do
    if [[ $known == *" $name "* ]]; then
      declared+="$name "
    else
      echo "✗ $file declares unknown gate '$name' (expected resolution, query or output)" >&2
      failed=1
    fi
  done
done <<<"$changed"

for gate in "$@"; do
  if [[ $known != *" $gate "* ]]; then
    echo "✗ unknown gate label gate:$gate (expected resolution, query or output)" >&2
    failed=1
  elif [[ $declared != *" $gate "* ]]; then
    echo "✗ gate:$gate has no added or modified test/fixture tagged for it (// @gate $gate or \"gates\": [\"$gate\"]) — CLAUDE.md §4.2" >&2
    failed=1
  fi
done

exit $failed
