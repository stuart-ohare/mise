#!/usr/bin/env bash
# PreToolUse(Bash). Enforces CLAUDE.md §4.1 (no work on main), §4.3 (commit subject),
# §4.5 (dependencies ask first; eval thresholds are not the agent's to change).
# Exit 2 denies with stderr shown to the agent; an "ask" decision puts it to the human.
# Shell parsing here is best-effort — the invariant-reviewer is the backstop.
set -uo pipefail

input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")
cwd=${cwd:-$PWD}

deny() { echo "$1" >&2; exit 2; }
ask() {
  jq -cn --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

ws='[[:space:]]'
nl=$'\n'

# Heredoc bodies are content, not commands: a doc that mentions a protected path isn't
# a write to it. Strip them before looking for writes.
q="'"
shell_lines=$(awk -v q="$q" '
  skip { if ($0 ~ "^[[:space:]]*" delim "[[:space:]]*$") skip = 0; next }
  { print
    if (match($0, "<<-?[[:space:]]*[\"" q "]?[A-Za-z_][A-Za-z0-9_]*")) {
      delim = substr($0, RSTART, RLENGTH); sub("^<<-?[[:space:]]*[\"" q "]?", "", delim); skip = 1
    } }' <<<"$cmd")

# True if a write-shaped operation targets $1 within one simple command.
writes_to() {
  local target=$1 seg="[^;&|$nl]*"
  local re="(>{1,2}$ws*[^[:space:];&|]*$target|tee$ws$seg$target|sed$ws+-i$seg$target|perl$ws+-[a-zA-Z]*i$seg$target|(^|[[:space:];&|(])(mv|cp|rm|truncate)$ws$seg$target|git$ws+(checkout|restore)$ws$seg$target)"
  [[ $shell_lines =~ $re ]]
}

# §4.5 — thresholds are set by consequence; a failing fixture means a better prompt.
if writes_to 'evals/thresholds'; then
  deny "evals/thresholds.ts is read-only for agents (CLAUDE.md §4.5: the exclusion threshold is 100% and not negotiable). Fix the prompt or schema, or stop and ask the human."
fi

# §4.5 — every dependency is a decision someone has to defend.
pm_start="(^|[;&|(]|$ws)"
pm_change="${pm_start}(pnpm|npm|yarn)$ws+(add|remove|rm|uninstall|un)($ws|\$)"
pm_install_pkg="${pm_start}(pnpm|npm)$ws+(install|i)$ws+[^-[:space:]]"
if [[ $shell_lines =~ $pm_change ]] || [[ $shell_lines =~ $pm_install_pkg ]]; then
  ask "Dependency change (CLAUDE.md §4.5). Approve only if this dependency is one you'll defend in review."
fi
if writes_to 'package\.json'; then
  ask "Shell write to package.json may change dependencies (CLAUDE.md §4.5)."
fi

git_sub="git($ws+-C$ws+[^[:space:]]+)?$ws+"
commit_re="${git_sub}commit($ws|\$)"
push_re="${git_sub}push($ws|\$)"
is_commit=false; is_push=false
[[ $shell_lines =~ $commit_re ]] && is_commit=true
[[ $shell_lines =~ $push_re ]] && is_push=true
$is_commit || $is_push || exit 0

dir=$cwd
git_c_re="git$ws+-C$ws+([^[:space:]]+)"
cd_re="^cd$ws+([^[:space:];&]+)"
if [[ $shell_lines =~ $git_c_re ]]; then
  dir=${BASH_REMATCH[1]}
elif [[ $shell_lines =~ $cd_re ]]; then
  dir=${BASH_REMATCH[1]}
fi
[[ $dir = /* ]] || dir="$cwd/$dir"
branch=$(git -C "$dir" symbolic-ref --short HEAD 2>/dev/null || true)

# Fail closed: a commit or push whose branch can't be determined up front (a shell
# variable in the path, a repo the same command creates) might be landing on main.
if [[ -z $branch ]]; then
  deny "Couldn't determine which branch this git commit/push targets (resolved dir: $dir). Use a literal path or run it from inside the repo so the main-branch guard can check it (CLAUDE.md §4.1)."
fi

# §4.1 — no issue, no branch.
if [[ $branch == main ]]; then
  deny "Refusing git commit/push on main (CLAUDE.md §4.1: no issue, no branch). Create <issue>-<kebab-summary> or use /build."
fi
to_main_re="(:main($ws|\$)|push$ws+[^[:space:]]+$ws+main($ws|\$))"
if $is_push && [[ $shell_lines =~ $to_main_re ]]; then
  deny "Refusing to push to main (CLAUDE.md §4.1). Push the issue branch and open a PR with /ship."
fi

$is_commit || exit 0

# §4.3 — imperative subject, ≤ 72 chars, references the issue.
subject=""
heredoc_re="<<"
dq_re="-m$ws*\"([^\"]*)\""
sq_re="-m$ws*'([^']*)'"
file_re="-F$ws+([^[:space:]]+)"
if [[ $cmd =~ $heredoc_re ]]; then
  subject=$(awk 'found { print; exit } /<</ { found = 1 }' <<<"$cmd")
elif [[ $cmd =~ $dq_re ]] || [[ $cmd =~ $sq_re ]]; then
  subject=$(head -n 1 <<<"${BASH_REMATCH[1]}")
elif [[ $cmd =~ $file_re ]]; then
  f=${BASH_REMATCH[1]}
  [[ $f = /* ]] || f="$dir/$f"
  subject=$(head -n 1 "$f" 2>/dev/null || true)
else
  exit 0
fi
subject=$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' <<<"$subject")

if (( ${#subject} > 72 )); then
  deny "Commit subject is ${#subject} chars; the limit is 72 (CLAUDE.md §4.3): \"$subject\""
fi
issue_ref_re="\(#[0-9]+\)"
if ! [[ $subject =~ $issue_ref_re ]]; then
  deny "Commit subject must reference its issue as (#n) (CLAUDE.md §4.3): \"$subject\""
fi
exit 0
