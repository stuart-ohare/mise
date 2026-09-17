#!/usr/bin/env bash
# Moves every issue a merged PR closes to status:done (ADR 0003's final stage).
# Run by .github/workflows/issue-done.yml; takes the PR number. The workflow only
# fires on merged PRs, but the check is repeated here because this is the layer the
# tests can exercise.
set -euo pipefail

pr=${1:?usage: mark-done.sh <pr-number>}

json=$(gh pr view "$pr" --json state,closingIssuesReferences)
if [[ $(jq -r .state <<<"$json") != MERGED ]]; then
  echo "PR #$pr is not merged; no issues relabelled."
  exit 0
fi

for issue in $(jq -r '.closingIssuesReferences[].number' <<<"$json"); do
  stale=$(gh issue view "$issue" --json labels |
    jq -r '[.labels[].name | select(startswith("status:") and . != "status:done")] | join(",")')
  args=(issue edit "$issue" --add-label status:done)
  [[ -n $stale ]] && args+=(--remove-label "$stale")
  gh "${args[@]}"
  echo "#$issue → status:done${stale:+ (removed $stale)}"
done
