# 3. Issue-driven agentic workflow

**Status:** accepted
**Date:** 2026-09-17

## Context

Agents do most of the typing in this repository. CLAUDE.md §4 described the process —
issue, failing test, implement, verify, PR — but only as prose, and prose is followed
when an agent remembers it. The rules that matter most here (don't touch main, don't
lower the exclusion threshold, a gate change needs a fixture) are exactly the ones an
agent under pressure to make something pass is most tempted to route around.

## Decision

The loop is five project skills, each moving a `status:*` label on the issue:

```
/spec    grill-me interview → human approves draft → issue filed        status:spec
/plan    plan posted as issue comment → human moves label               status:planned
/build   worktree, failing test first, smallest change                  status:building
/verify  scripts/workflow/verify.sh + invariant-reviewer subagent
/ship    PR with every criterion ticked against evidence                status:in-review
merge    human, always; CI then relabels the closed issue               status:done
```

- **Humans approve three things:** the spec (before filing), the plan (by moving the
  label to `status:planned` — the skills never add it), and the merge.
- **What can be a script is a script.** `verify.sh` runs the definition of done and the
  §4.2 fixture rule for `gate:*` issues, and records the verified commit; `/ship`
  refuses any other commit.
- **What must never happen is a hook, and each rule is enforced where the real state is
  visible.**
  - **Git hooks** (`.githooks/`, installed by `pnpm i` via `prepare`): `pre-commit`
    rejects commits on `main`, `pre-push` rejects any update to `refs/heads/main`, and
    `commit-msg` enforces ≤ 72 chars with `(#n)`. Git hands them the real branch, refs
    and message, so they don't depend on how a command was spelled, and they cover
    humans too.
  - **Claude Code hooks** (`.claude/hooks/`) cover what git can't see:
    - They deny `--no-verify`, `commit -n`, and retargeting or unsetting `core.hooksPath`.
    - They deny writes to `evals/thresholds.ts` and to the `/verify` record.
    - They ask the human before dependency changes and before edits to the guards
      themselves.
  - Both sets run real inputs in `scripts/workflow/{githooks,hooks}.test.ts`.
- **Review comes from fresh context.** `invariant-reviewer` sees the diff, the issue and
  CLAUDE.md — never the building conversation. It runs only locally, in `/verify`, and
  its report goes in the PR body.
- **CI is deterministic only** (#4). `checks` runs typecheck, lint and test and is
  required on `main`. `issue-done` (#11) moves the issues a merged PR closes to
  `status:done`, using `scripts/workflow/mark-done.sh` and the built-in token. No
  workflow calls a model or holds an Anthropic secret.
- **Gate labels** (`gate:resolution|query|output`) make the fixture rule mechanical, and
  the reviewer flags gate-path changes without one.

## Alternatives considered

- **Fully CI-driven loop** (label an issue, an Action builds and opens a PR). Most
  hands-off, but opaque, expensive, and impossible to steer mid-task.
- **Claude review and `@claude` in CI** (claude-code-action). This was built in #4 and
  removed before merge.
  - **For:** a second review visible on GitHub.
  - **Against:**
    - It duplicates the local reviewer.
    - It spends money on events nobody chose to pay for. The app installer's own
      workflow ran a review on its setup PR before anyone approved it.
    - It needs API secrets in the repo.
    - It opens a second path where Claude acts outside the plan approval and the
      local guards.
- **GitHub Projects board for state.** Better-looking for a reviewer, but needs extra
  token scopes and project IDs to script. Labels are visible from the issue list and
  one `gh` call to move.
- **CI-only review.** Findings arrive after the PR is public and each costs a round trip.
- **Self-review in the building session.** Anchored on the author's own reasoning — the
  failure mode an independent reviewer exists to avoid.

## Cost accepted

- **Approval is honour-system at the identity level.** The agent's `gh` runs as the same
  account as the human, so GitHub can't distinguish who moved `status:planned`. The skills
  forbid it; nothing technically prevents it. A separate bot identity would close this.
- **Claude Code hooks parse shell text, so they're best-effort.** An indirect write gets
  past them (a script or `python -c` that opens the thresholds file), and heredoc bodies
  are deliberately ignored. The first build tried to enforce the git rules this way too.
  An independent review found six bypasses (`git -c x commit`, `push -u origin main`,
  `checkout main && commit`, `commit -am`, …), which is why those rules moved into git
  hooks.
  A second review found more routes past the Claude hooks. The cheap ones are closed:
  `chmod -x` on the git hooks, `.git/config` edits, and a second `-c core.hooksPath`.
  These are accepted as known gaps:
  - a quoted `"-n"`, and a fake `<<X` marker that hides later lines
  - a heredoc body fed to `bash`
  - `dd of=`, and copying into the `evals/` directory rather than the file
  - `./` or `//` in paths passed to Edit/Write
  - `package.json` edits that don't look like dependencies
  - `pnpm-workspace.yaml` overrides
  - A whole command is denied if any part of it contains `--no-verify` or a
    protected path in a write-shaped position, even inside a quoted message.
    Use a heredoc or `--body-file` for text like that.
- **Local hooks are not a guarantee.** Anyone with a shell can skip them.
  - `pnpm i --ignore-scripts` skips the install.
  - A worktree made from a commit without `.githooks/` has no hooks.
  - Local `main` can still move by fast-forward, cherry-pick or rebase. Only `pre-push`
    stops those changes reaching origin.
  - Branch protection on `main` (added in #4) is the guarantee: a PR is required,
    `checks` must pass, and admins aren't exempt. The hooks make the right path the easy one.
- **`verify.sh` checks that `evals/latest.md` changed, not that it passes.** Any test
  file counts toward the fixture rule. Checking the eval report needs the eval runner
  to exist first (follow-up issue).
- **Some steps are enforced by instruction only:**
  - `/ship` checks that `verify.sh` passed for the commit, not that the reviewer ran.
  - The reviewer has Bash, so "read-only" is an instruction, not a tool restriction.
  - The *Invariant review* section of a PR body is written by the agent that ran it.
    Nothing on GitHub re-runs or verifies it.
- **`jq` is a prerequisite** for the hooks. No new package dependency.
- Skills are prose the model follows. Where a step matters enough, it has been moved into
  a script or hook rather than trusted.
