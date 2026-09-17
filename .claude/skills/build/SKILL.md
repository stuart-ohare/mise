---
name: build
description: Implement an approved Mise issue in its own git worktree — failing test or fixture first, then the smallest change that passes. Third step of the loop. Use for "/build <n>" or "implement issue <n>".
---

# /build <n> — approved plan → committed change

## 1. Refuse without approval

```bash
gh issue view <n> --json state,labels,title,body,comments
```

Proceed only if the issue is open **and** labelled `status:planned`, and a `## Plan`
comment exists. Otherwise stop: tell the user to approve the plan with `/approve <n>`.
Never add the label yourself.

Read the plan and every `## Plan amendment` after it. The plan is the scope.

## 2. Worktree

Parallel agent work never shares a working tree (§4.3).

```bash
slug=<kebab-summary from the title, ≤ 5 words>
branch=<n>-$slug
wt=$(git rev-parse --show-toplevel)/../mise-worktrees/$branch
git fetch origin main
git worktree add -b "$branch" "$wt" origin/main   # or without -b if the branch exists
cp .env.local "$wt/" 2>/dev/null || true
(cd "$wt" && pnpm i --frozen-lockfile)
gh issue edit <n> --remove-label status:planned --add-label status:building
```

From here, run every command inside `$wt` (absolute paths, or `git -C "$wt"`). Tell the
user the worktree path.

## 3. Failing test first

Write the test or eval fixture named in the plan. Run it and **show it failing** for the
right reason (an assertion, not an import error). Commit it on its own:
`Add failing test for <behaviour> (#<n>)`.

## 4. Implement

The smallest change that makes it pass. Follow CLAUDE.md §2 and §6. While working:

- Out-of-plan work you notice → note it for a follow-up issue; don't do it.
- Any §4.5 condition → stop and ask. The hooks will stop you on thresholds, dependencies,
  and commits on main; don't look for another route around them.
- Prompt text changed → bump that prompt's `VERSION`.

## 5. Commit

Subject: imperative, ≤ 72 chars, ending `(#<n>)`. Body: why, not what (§4.3). One
concern per commit where it helps a reviewer. End with the session's attribution line.

When the plan is implemented and `pnpm test` passes locally, tell the user the next step
is `/verify`.
