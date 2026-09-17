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
merge    human, always
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
  CLAUDE.md — never the building conversation. The CI review (#4) uses the same definition.
- **Gate labels** (`gate:resolution|query|output`) make the fixture rule mechanical, and
  the reviewer flags gate-path changes without one.

## Alternatives considered

- **Fully CI-driven loop** (label an issue, an Action builds and opens a PR). Most
  hands-off, but opaque, expensive, and impossible to steer mid-task. Rejected; CI gets
  checks and review only (#4).
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
- **Local hooks are not a guarantee.** Anyone with a shell can skip them. Branch
  protection on `main` (#4) is the guarantee; the hooks make the right path the easy one.
- **Some steps are enforced by instruction only:**
  - `/ship` checks that `verify.sh` passed for the commit, not that the reviewer ran.
  - The reviewer has Bash, so "read-only" is an instruction, not a tool restriction.
- **`jq` is a prerequisite** for the hooks. No new package dependency.
- Skills are prose the model follows. Where a step matters enough, it has been moved into
  a script or hook rather than trusted.
