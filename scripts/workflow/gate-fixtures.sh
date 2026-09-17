#!/usr/bin/env bash
# CLAUDE.md §4.2 for gate-labelled issues: every labelled gate needs a test or eval
# fixture, added or modified since <base-ref>, that declares that gate —
#   Vitest:       // @gate query output
#   JSON fixture: "gates": ["output"]
# Unknown gate names fail on every issue; tagged files are required only for the gates
# passed in. Called by verify.sh; tested offline in gate-fixtures.test.ts.
set -euo pipefail

base=${1:?usage: gate-fixtures.sh <base-ref> [gate…]}
shift

cd "$(git rev-parse --show-toplevel)"

is_known() { case $1 in resolution | query | output) return 0 ;; *) return 1 ;; esac; }
declared=" "
failed=0

# Content comes from HEAD, not the working tree, so this checks exactly what was committed.
changed=$(git diff --name-only --diff-filter=ACMR "$base" HEAD)
while IFS= read -r file; do
  case $file in
    *.test.ts)
      names=$(git show "HEAD:$file" | sed -nE 's#^[[:space:]]*//[[:space:]]*@gate[[:space:]]+(.*)$#\1#p' |
        tr -s '[:space:]' '\n') ;;
    evals/fixtures/*.json)
      if ! names=$(git show "HEAD:$file" | jq -r '(.gates // []) | .[]' 2>/dev/null); then
        echo "✗ $file isn't valid JSON with a \"gates\" array" >&2
        failed=1
        continue
      fi ;;
    *) continue ;;
  esac
  # One name per line: a JSON entry like "query output" stays one (unknown) name.
  while IFS= read -r name; do
    [[ -n $name ]] || continue
    if is_known "$name"; then
      declared+="$name "
    else
      echo "✗ $file declares unknown gate '$name' (expected resolution, query or output)" >&2
      failed=1
    fi
  done <<<"$names"
done <<<"$changed"

for gate in "$@"; do
  if ! is_known "$gate"; then
    echo "✗ unknown gate label gate:$gate (expected resolution, query or output)" >&2
    failed=1
  elif [[ $declared != *" $gate "* ]]; then
    echo "✗ gate:$gate has no added or modified test/fixture tagged for it (// @gate $gate or \"gates\": [\"$gate\"]) — CLAUDE.md §4.2" >&2
    failed=1
  fi
done

exit $failed
