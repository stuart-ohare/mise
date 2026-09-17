#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit). Enforces CLAUDE.md §4.5 — eval thresholds are
# read-only for agents and dependency changes go to the human — and protects the
# /verify record and the workflow guards themselves.
set -uo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "guard-edit: jq is required for the workflow guards (see README). Denying until it's installed." >&2
  exit 2
fi

input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")
# macOS filesystems are case-insensitive, so Evals/Thresholds.ts is the same file.
path=$(jq -r '.tool_input.file_path // ""' <<<"$input" | tr '[:upper:]' '[:lower:]')

ask() {
  jq -cn --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

case $path in
  */evals/thresholds.ts | evals/thresholds.ts)
    echo "evals/thresholds.ts is read-only for agents (CLAUDE.md §4.5: the exclusion threshold is 100% and not negotiable). A failing fixture means a better prompt or a narrower schema — stop and ask the human." >&2
    exit 2 ;;
  */mise-verified)
    echo "The verified record is written only by scripts/workflow/verify.sh. Run /verify." >&2
    exit 2 ;;
  */.githooks/* | */.claude/hooks/* | */.claude/settings*.json)
    ask "$tool changes the workflow guards themselves. Approve only if that's the intended change." ;;
  */package.json | package.json) ;;
  *) exit 0 ;;
esac

# package.json from here. A whole-file rewrite or multi-edit can't be cheaply
# inspected, so it always asks.
[[ $tool == Edit ]] || ask "$tool on package.json may change dependencies (CLAUDE.md §4.5)."

# An edit is treated as a dependency change if it names a dependency block or
# touches anything shaped like a version specifier.
text=$(jq -r '(.tool_input.old_string // "") + "\n" + (.tool_input.new_string // "")' <<<"$input")
deps='[dD]ependencies'
version='"[^"]+":[[:space:]]*"(\^|~|>=|workspace:|npm:)?[0-9]'
if [[ $text =~ $deps ]] || [[ $text =~ $version ]]; then
  ask "Edit touches package.json dependencies (CLAUDE.md §4.5)."
fi
exit 0
