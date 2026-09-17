#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit). Enforces CLAUDE.md §4.5: eval thresholds are
# read-only for agents, and dependency changes go to the human first.
set -uo pipefail

input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")
path=$(jq -r '.tool_input.file_path // ""' <<<"$input")

if [[ $path == */evals/thresholds.ts || $path == evals/thresholds.ts ]]; then
  echo "evals/thresholds.ts is read-only for agents (CLAUDE.md §4.5: the exclusion threshold is 100% and not negotiable). A failing fixture means a better prompt or a narrower schema — stop and ask the human." >&2
  exit 2
fi

[[ $path == */package.json || $path == package.json ]] || exit 0

ask() {
  jq -cn --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

# A whole-file rewrite or multi-edit can't be cheaply inspected, so it always asks.
[[ $tool == Edit ]] || ask "$tool on package.json may change dependencies (CLAUDE.md §4.5)."

# An edit is treated as a dependency change if it names a dependency block or
# touches anything shaped like a version specifier.
text=$(jq -r '(.tool_input.old_string // "") + "\n" + (.tool_input.new_string // "")' <<<"$input")
version='"[^"]+":[[:space:]]*"(\^|~|>=|workspace:|npm:)?[0-9]'
deps='[dD]ependencies'
if [[ $text =~ $deps ]] || [[ $text =~ $version ]]; then
  ask "Edit touches package.json dependencies (CLAUDE.md §4.5)."
fi
exit 0
