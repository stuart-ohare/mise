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
gates=$(gh issue view "$issue" --json labels -q '[.labels[].name | select(startswith("gate:"))] | join(",")')

echo
if [[ -n $gates ]]; then
  echo "▶ #$issue touches $gates — checking §4.2 fixture rule"
  if ! grep -Eq '(\.test\.ts$|^evals/fixtures/)' <<<"$changed"; then
    echo "✗ No test or eval fixture added or changed. A gate change with no fixture covering it does not merge (CLAUDE.md §4.2)" >&2
    exit 1
  fi
  if ! grep -qx 'evals/latest.md' <<<"$changed"; then
    echo "✗ evals/latest.md not regenerated. Run pnpm eval (costs money — §4.6) and commit the report (§4.4)" >&2
    exit 1
  fi
  echo "✓ fixture changed and evals/latest.md regenerated"
else
  echo "▶ #$issue has no gate:* label — fixture rule not required"
fi

sha=$(git rev-parse HEAD)
echo "$sha" > "$(git rev-parse --git-dir)/mise-verified"
echo
echo "✓ Deterministic checks passed for #$issue at ${sha:0:7}. Now run the invariant-reviewer."
