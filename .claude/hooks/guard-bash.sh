#!/usr/bin/env bash
# PreToolUse(Bash). Guards what git's own hooks (.githooks) can't see:
#   - switching those git hooks off (--no-verify, core.hooksPath)       deny
#   - writes to eval thresholds or the /verify record (CLAUDE.md §4.5)  deny
#   - dependency changes, and edits to the guards themselves            ask
# Exit 2 denies with stderr shown to the agent; "ask" puts it to the human.
# This reads shell text, so it's best-effort: it closes the obvious routes, and the
# reviewer, branch protection and the human merge are the backstop.
set -uo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "guard-bash: jq is required for the workflow guards (see README). Denying until it's installed." >&2
  exit 2
fi

input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")

deny() { echo "$1" >&2; exit 2; }
ask() {
  jq -cn --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

ws='[[:space:]]'
nl=$'\n'
seg="[^;&|$nl]*"
start="(^|[[:space:];&|(])"

# Heredoc bodies are content, not commands: a doc or commit message that mentions a
# protected path isn't a write to it. Here-strings (<<<) are not heredocs.
q="'"
shell_lines=$(awk -v q="$q" '
  skip { if ($0 ~ "^[[:space:]]*" delim "[[:space:]]*$") skip = 0; next }
  { print
    if (match($0, "(^|[^<])<<-?[[:space:]]*[\"" q "]?[A-Za-z_][A-Za-z0-9_-]*")) {
      delim = substr($0, RSTART, RLENGTH); sub("^[^<]*<<-?[[:space:]]*[\"" q "]?", "", delim); skip = 1
    } }' <<<"$cmd")
# macOS filesystems are case-insensitive, so Evals/Thresholds.ts is the same file.
lower=$(tr '[:upper:]' '[:lower:]' <<<"$shell_lines")

# True if a write-shaped operation targets $1 (a lowercase regex) in one simple command.
writes_to() {
  local t=$1
  local redirect=">{1,2}$seg$t"
  local inplace="(tee$ws$seg$t|sed$ws($seg$ws)?-i$seg$t|perl$ws($seg$ws)?-[a-z]*i$seg$t)"
  local copy_to="${start}(cp|mv)$ws$seg$ws[^[:space:];&|]*$t[^[:space:];&|]*$ws*(\$|[;&|]|$nl)"
  local remove="${start}(rm|truncate)$ws$seg$t"
  local restore="git$ws+(checkout|restore)$ws$seg$t"
  [[ $lower =~ ($redirect|$inplace|$copy_to|$remove|$restore) ]]
}

# The git hooks are the real enforcement of §4.1 and §4.3; switching them off is the
# one bypass that must never be available to an agent.
no_verify="(^|$ws)--no-verify($ws|\$)"
commit_n="git$ws($seg$ws)?commit$ws($seg$ws)?-[a-z]*n[a-z]*($ws|\$)"
set_hooks_path="core\.hookspath(=|$ws+)([^[:space:];&|]+)"
unset_hooks_path="--(unset|unset-all|remove-section)$ws+core"
remove_guards="${start}(rm|mv)$ws$seg(\.githooks|\.claude/hooks|\.claude/settings)"
retargets_hooks=false
if [[ $lower =~ $set_hooks_path ]] && [[ ${BASH_REMATCH[2]} != .githooks ]]; then
  retargets_hooks=true
fi
if [[ $shell_lines =~ $no_verify ]] || [[ $lower =~ $commit_n ]] || $retargets_hooks ||
   [[ $lower =~ $unset_hooks_path ]] || [[ $lower =~ $remove_guards ]]; then
  deny "Git hooks can't be bypassed or removed by an agent (CLAUDE.md §4.1, §4.3). Fix what the hook rejected, or stop and ask the human."
fi

# §4.5 — thresholds are set by consequence; a failing fixture means a better prompt.
if writes_to 'thresholds\.ts'; then
  deny "evals/thresholds.ts is read-only for agents (CLAUDE.md §4.5: the exclusion threshold is 100% and not negotiable). Fix the prompt or schema, or stop and ask the human."
fi

# /ship trusts this record; only scripts/workflow/verify.sh writes it.
if writes_to 'mise-verified'; then
  deny "The verified record is written only by scripts/workflow/verify.sh. Run /verify."
fi

# §4.5 — every dependency is a decision someone has to defend.
opts="($ws+-[^[:space:]]+($ws+[^-[:space:];&|][^[:space:];&|]*)?)*"
pm_change="${start}(pnpm|npm|yarn)$opts$ws+(add|remove|rm|uninstall|un|update|up|upgrade)($ws|\$)"
pm_install_pkg="${start}(pnpm|npm)$ws+(install|i)($ws+-[^[:space:]]+)*$ws+[^-[:space:];&|]"
if [[ $lower =~ $pm_change ]] || [[ $lower =~ $pm_install_pkg ]]; then
  ask "Dependency change (CLAUDE.md §4.5). Approve only if this dependency is one you'll defend in review."
fi
if writes_to 'package\.json'; then
  ask "Shell write to package.json may change dependencies (CLAUDE.md §4.5)."
fi

if writes_to '(\.githooks|\.claude/hooks|\.claude/settings)'; then
  ask "This changes the workflow guards themselves. Approve only if that's the intended change."
fi

exit 0
