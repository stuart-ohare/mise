#!/usr/bin/env bash
# PreToolUse(Bash). Guards what git's own hooks (.githooks) can't see:
#   - switching those git hooks off (--no-verify, core.hooksPath, chmod)  deny
#   - writes to eval thresholds or the /verify record (CLAUDE.md §4.5)    deny
#   - dependency changes, and edits to the guards themselves              ask
# Exit 2 denies with stderr shown to the agent; "ask" puts it to the human.
#
# This reads shell text, so it closes the obvious routes and no more — known gaps are
# listed in ADR 0003. Branch protection on main is the guarantee; this is a speed bump.
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
end='$' # inside an inline [[ =~ ]], \$ is a literal dollar, not an anchor

# Heredoc bodies are content, not commands: a doc or commit message that mentions a
# protected path isn't a write to it. Here-strings (<<<) are not heredocs.
q="'"
shell_lines=$(awk -v q="$q" '
  skip { if ($0 ~ "^[[:space:]]*" delim "[[:space:]]*$") skip = 0; next }
  { print
    if (match($0, "(^|[^<])<<-?[[:space:]]*[\"" q "]?[A-Za-z_][A-Za-z0-9_-]*")) {
      delim = substr($0, RSTART, RLENGTH); sub("^[^<]*<<-?[[:space:]]*[\"" q "]?", "", delim); skip = 1
    } }' <<<"$cmd")

# One simple command per line. Lowercased because macOS filesystems are
# case-insensitive (Evals/Thresholds.ts is the same file) and git config keys are too.
segments=$(tr '[:upper:]' '[:lower:]' <<<"$shell_lines" | tr ';&|' '\n\n\n')

# True if segment $1 performs a write-shaped operation on target regex $2.
writes_to() {
  local s=$1 t=$2
  [[ $s =~ \>{1,2}.*$t ]] && return 0
  [[ $s =~ (^|$ws)(tee$ws.*$t|sed$ws(.*$ws)?-i.*$t|perl$ws(.*$ws)?-[a-z]*i.*$t) ]] && return 0
  [[ $s =~ (^|$ws)(cp|mv|install|rsync)$ws.*$ws[^[:space:]]*$t[^[:space:]]*$ws*$end ]] && return 0
  [[ $s =~ (^|$ws)(rm|truncate|chmod)$ws.*$t ]] && return 0
  [[ $s =~ (^|$ws)git$ws+checkout$ws.*$t ]] && return 0
  if [[ $s =~ (^|$ws)git$ws+restore$ws.*$t ]]; then
    # --staged alone only unstages; the file on disk is untouched.
    [[ $s =~ $ws--staged ]] && ! [[ $s =~ $ws(--worktree|-w)($ws|$end) ]] || return 0
  fi
  return 1
}

# A core.hooksPath value other than the repo's own hooks switches them off.
check_hooks_path() {
  local rest=$1 re=$2 value
  while [[ $rest =~ $re ]]; do
    value=${BASH_REMATCH[${#BASH_REMATCH[@]}-1]}
    value=${value//\"/}
    value=${value//\'/}
    [[ $value == .githooks || $value == ./.githooks ]] || return 1
    rest=${rest#*"${BASH_REMATCH[0]}"}
  done
  return 0
}

hooks_off="Git hooks can't be switched off by an agent (CLAUDE.md §4.1, §4.3). Fix what the hook rejected, or stop and ask the human."

# Pass 1 — denials. All of them run before any "ask", so an ask can't mask a deny.
while IFS= read -r s; do
  if [[ $s =~ (^|$ws|\()git$ws ]]; then
    # Quoted or abbreviated (git accepts --no-verif) still counts.
    [[ $s =~ (^|[[:space:]\"\'=])--no-verif ]] && deny "$hooks_off"
    unquoted=$(sed -E "s/\"[^\"]*\"//g; s/'[^']*'//g" <<<"$s")
    [[ $unquoted =~ (^|$ws)commit$ws(.*$ws)?-[a-z]*n[a-z]*($ws|$end) ]] && deny "$hooks_off"
    check_hooks_path "$s" "-c$ws*(core\.hookspath)=([^[:space:]]*)" || deny "$hooks_off"
    check_hooks_path "$s" "config$ws(.*$ws)?(core\.hookspath)$ws+([^[:space:]-][^[:space:]]*)" || deny "$hooks_off"
    [[ $s =~ config$ws(.*$ws)?(--unset|--unset-all|unset|--remove-section|remove-section)$ws.*core ]] && deny "$hooks_off"
    [[ $s =~ config$ws(.*$ws)?(--edit|edit|-e)($ws|$end) ]] && deny "$hooks_off"
  fi
  [[ $s =~ (^|$ws)(rm|mv|chmod|chflags)$ws.*(\.githooks|\.claude/hooks|\.claude/settings) ]] && deny "$hooks_off"
  writes_to "$s" '\.git/config' && deny "$hooks_off"

  # §4.5 — thresholds are set by consequence; a failing fixture means a better prompt.
  writes_to "$s" 'thresholds\.ts' &&
    deny "evals/thresholds.ts is read-only for agents (CLAUDE.md §4.5: the exclusion threshold is 100% and not negotiable). Fix the prompt or schema, or stop and ask the human."

  # /ship trusts this record; only scripts/workflow/verify.sh writes it.
  writes_to "$s" 'mise-verified' &&
    deny "The verified record is written only by scripts/workflow/verify.sh. Run /verify."
done <<<"$segments"

# Pass 2 — questions for the human.
opts="($ws+-[^[:space:]]+($ws+[^-[:space:]][^[:space:]]*)?)*"
while IFS= read -r s; do
  # §4.5 — every dependency is a decision someone has to defend.
  if [[ $s =~ (^|$ws|\()(pnpm|npm|yarn)$opts$ws+(add|remove|rm|uninstall|un|update|up|upgrade)($ws|$end) ]] ||
     [[ $s =~ (^|$ws|\()(pnpm|npm)$ws+(install|i)($ws+-[^[:space:]]+)*$ws+[^-[:space:]] ]]; then
    ask "Dependency change (CLAUDE.md §4.5). Approve only if this dependency is one you'll defend in review."
  fi
  writes_to "$s" 'package\.json' &&
    ask "Shell write to package.json may change dependencies (CLAUDE.md §4.5)."
  writes_to "$s" '(\.githooks|\.claude/hooks|\.claude/settings)' &&
    ask "This changes the workflow guards themselves. Approve only if that's the intended change."
done <<<"$segments"

exit 0
