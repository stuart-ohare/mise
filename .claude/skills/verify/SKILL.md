---
name: verify
description: Run Mise's definition of done on the current issue branch — deterministic checks via scripts/workflow/verify.sh, then an independent invariant-reviewer subagent. Fourth step of the loop; /ship requires it. Use for "/verify" or "is this done".
---

# /verify — prove it, don't claim it

"It should work" is not verification (§4.2). Run everything from the issue's worktree.

## 1. Deterministic checks

```bash
scripts/workflow/verify.sh
```

It refuses a dirty tree, then runs typecheck, lint and test, and — for `gate:*`
issues — requires a changed test/fixture and a regenerated `evals/latest.md`. On success
it records the verified commit for `/ship`.

If it fails: fix the cause and re-run. Never lower a threshold, skip a test, or relabel
the issue to get past the gate check. If `evals/latest.md` is required, `pnpm eval` costs
real money — confirm with the user before running it (§4.6), and never commit a report
that wasn't actually produced by a run.

## 2. Independent review

Launch the `invariant-reviewer` agent. Give it **only**:

> Review issue #<n>. Base ref: `origin/main`. Worktree: `<absolute path>`.

Do not pass your reasoning, a summary of the change, or what you think is risky — a
reviewer handed your conclusion tends to return it confirmed.

## 3. Act on findings

- **BLOCK** — fix, commit, and go back to step 1. The verified marker is per commit, so
  any new commit needs a fresh run.
- **CONCERNS** — show each to the user with your assessment; fix or get an explicit
  decision to proceed. Record the decision for the PR body.
- **CLEAN** — continue.

## 4. Collect evidence

For each acceptance criterion in the issue, gather the proof: command output, test
names, screenshots (use the `run` skill for UI). Keep it for `/ship`. Tell the user what
passed and what the reviewer said, then that the next step is `/ship`.
