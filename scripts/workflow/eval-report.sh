#!/usr/bin/env bash
# CLAUDE.md §4.4: a change that can move an eval result has to commit a regenerated
# evals/latest.md. The question is what the diff touched, not what the issue is
# labelled — a gate label doesn't make the model behave differently, and a prompt
# rewritten on an unlabelled issue changes the report either way (#66).
#
# The allowlist below is what `pnpm eval` loads: the runner, its fixtures, the prompts
# and client they call, and the domain modules the scorers import. It is static, so
# eval-report.test.ts walks the real import graph and fails if it drifts.
# Called by verify.sh; tested offline in eval-report.test.ts.
set -euo pipefail

base=${1:?usage: eval-report.sh <base-ref>}

cd "$(git rev-parse --show-toplevel)"

# *.md can't change a run (evals/latest.md least of all — it's the output), and the
# Vitest files beside the runner aren't loaded by it.
is_eval_input() {
  case $1 in
    *.md | *.test.ts) return 1 ;;
    evals/* | lib/ai/*) return 0 ;;
    lib/domain/constraints.ts | lib/domain/resolve-exclusions.ts | lib/domain/taxonomy.ts) return 0 ;;
    *) return 1 ;;
  esac
}

changed=$(git diff --name-only --diff-filter=ACMR "$base" HEAD)

inputs=()
while IFS= read -r file; do
  [[ -n $file ]] || continue
  is_eval_input "$file" && inputs+=("$file")
done <<<"$changed"

if [[ ${#inputs[@]} -eq 0 ]]; then
  echo "✓ no path pnpm eval reads changed — evals/latest.md not required (§4.4)"
  exit 0
fi

if grep -qx 'evals/latest.md' <<<"$changed"; then
  echo "✓ ${inputs[*]} can change an eval result — evals/latest.md regenerated (§4.4)"
  exit 0
fi

echo "✗ ${inputs[*]} can change an eval result, but evals/latest.md wasn't regenerated." >&2
echo "  Run pnpm eval (costs money — §4.6) and commit the report (§4.4)." >&2
exit 1
