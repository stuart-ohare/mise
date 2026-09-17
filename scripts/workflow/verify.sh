#!/usr/bin/env bash
# The deterministic half of /verify: CLAUDE.md §4.4 as a script, so no step can be
# skipped by an agent deciding it "obviously" passes. On success it records the
# verified commit; /ship refuses to open a PR for any other commit.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

branch=$(git symbolic-ref --short HEAD)
if ! [[ $branch =~ ^([0-9]+)- ]]; then
  echo "✗ Branch '$branch' isn't <issue>-<kebab-summary> (CLAUDE.md §4.3)" >&2
  exit 1
fi
issue=${BASH_REMATCH[1]}

if [[ -n $(git status --porcelain) ]]; then
  echo "✗ Working tree has uncommitted changes — verify a commit, not a working tree" >&2
  exit 1
fi

step() { echo; echo "▶ $*"; "$@"; }
step pnpm typecheck
step pnpm lint
step pnpm test

git fetch -q origin main
base=$(git merge-base origin/main HEAD)
changed=$(git diff --name-only --diff-filter=ACMR "$base" HEAD)
gates=$(gh issue view "$issue" --json labels -q '[.labels[].name | select(startswith("gate:"))] | join(" ")')

read -ra gate_names <<<"${gates//gate:/}"

echo
echo "▶ Checking gate tags on changed tests and fixtures"
# Always run: unknown gate names fail even on issues with no gate:* label.
scripts/workflow/gate-fixtures.sh "$base" ${gate_names[@]+"${gate_names[@]}"}

if [[ -n $gates ]]; then
  echo "▶ #$issue touches $gates — checking §4.2 fixture rule"
  if ! grep -qx 'evals/latest.md' <<<"$changed"; then
    echo "✗ evals/latest.md not regenerated. Run pnpm eval (costs money — §4.6) and commit the report (§4.4)" >&2
    exit 1
  fi
  echo "✓ each gate has a tagged test or fixture, and evals/latest.md is regenerated"
else
  echo "▶ #$issue has no gate:* label — fixture rule not required"
fi

sha=$(git rev-parse HEAD)
echo "$sha" > "$(git rev-parse --git-dir)/mise-verified"
echo
echo "✓ Deterministic checks passed for #$issue at ${sha:0:7}. Now run the invariant-reviewer."
