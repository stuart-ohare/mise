# How this repo was built

Agents did most of the typing here. This page shows that the process around them did
more than add ceremony. It traces three changes through this repo's own history, and
each trace names what the process caught. The rules themselves are in
[CLAUDE.md §4](../CLAUDE.md#4-the-agentic-workflow). Why they are built this way is in
[ADR 0003](decisions/0003-issue-driven-agentic-workflow.md).

## The loop

```
/spec     issue drafted one question at a time      human approves draft   status:spec
/plan     plan posted as an issue comment
/approve  human-only skill moves the label          human approves plan    status:planned
/build    own worktree, failing test first                                 status:building
/verify   verify.sh + fresh-context invariant-reviewer  human decides CONCERNS
/ship     PR ticks every criterion against evidence                         status:in-review
merge     human, always; CI relabels closed issues  human merges           status:done
```

A human approves three things: the spec, the plan and the merge. The human also decides
on anything the reviewer raises as a concern, and on dependency changes and edits to the
guards. The rest is agent work, and it leaves a record on the issue and the PR.

## Trace 1: one issue, end to end

**[#82](https://github.com/stuart-ohare/mise/issues/82) → [PR #92](https://github.com/stuart-ohare/mise/pull/92).**
This change lets a reviewer say what an unresolved term means, then re-resolve every draft
line held by that term.

- **The spec made the schema decision.** It adds a `name` column to `recipe_ingredient`,
  so re-resolution is an exact lookup. It also recorded the rejected alternative:
  re-scanning `raw_text` would mean substring-matching prose like "a knob of ghee,
  melted" to decide what an ingredient is.
- **The plan was approved before the build.** The issue's label history shows
  `status:planned` before `status:building`.
- **Review changed the design twice.** Each change was filed as a plan amendment rather
  than written into history:
  [amendment one](https://github.com/stuart-ohare/mise/issues/82#issuecomment-5727822634)
  and [amendment two](https://github.com/stuart-ohare/mise/issues/82#issuecomment-5727995841).
- **The PR ticks each acceptance criterion against a named test.** One box stays
  unticked: the screenshot of the fix clearing a blocker in `/review`. `gh` can't attach
  images, so the PR said the screenshots would follow as a comment, and didn't tick the
  box. The PR merged without that comment. Planning this page found the gap, and the
  screenshots went up about 75 minutes after merge, as
  [a comment on the PR](https://github.com/stuart-ohare/mise/pull/92#issuecomment-5728913481).

**Caught:** two design changes, each traceable to the review finding that forced it. And
one criterion that couldn't be evidenced when the PR was written, left open rather than
claimed. An honest unchecked box is what makes the other boxes believable. The same box
also shows a gap: nothing checked that its promise was kept before the human merged.

## Trace 2: the process noticing it rewarded the wrong thing

**[#56](https://github.com/stuart-ohare/mise/issues/56) / [PR #65](https://github.com/stuart-ohare/mise/pull/65)
→ [#66](https://github.com/stuart-ohare/mise/issues/66) / [PR #70](https://github.com/stuart-ohare/mise/pull/70).**

#56 built the Cook screen, which included gate-1 logic. The `invariant-reviewer` flagged
the missing `gate:resolution` label; #66 records that it did so in all three passes. It
was right. The
label had been withheld on purpose. At the time, a `gate:*` label made `verify.sh` demand
a regenerated `evals/latest.md`, which meant a paid `pnpm eval` run producing a report that
could not differ: no prompt, fixture or model-facing behaviour had changed. PR #65 records
that human decision. The fixture rule was met anyway, by the agent adding
`// @gate resolution` to the tests itself rather than by the tool requiring it.

#66 named the problem: correct labelling was priced in API credits, and the predictable
result is a gate change landing unlabelled. PR #70 made the report requirement follow the
diff instead of the label. It fires when a change touches something `pnpm eval` reads, on
any issue. The declared-fixture rule for gate labels didn't change. #56 was then
retro-labelled, and PR #70 shows it still passing both checks at its merge commit.

**Caught:** a rule that made the correct action expensive and the wrong one free. The fix
went into the tooling, and the standard stayed where it was.

## Trace 3: review finding real defects

**The "Fixes found while verifying" section of [PR #92](https://github.com/stuart-ohare/mise/pull/92).**
Both defects were found by the `invariant-reviewer` before merge. Each fix landed as a
failing test first, then the fix.

- **A draft line could be left with no way to fix it.** Intake builds its resolution index
  and then writes the draft. If an alias landed in between, the line was stored unresolved
  under a term that now existed, and the alias route answered 409 for it forever.
  Test [`2ec5ed9`](https://github.com/stuart-ohare/mise/commit/2ec5ed9), fix
  [`2e19dea`](https://github.com/stuart-ohare/mise/commit/2e19dea).
- **The alias route could rewrite gate 1's index.** The route has no auth, so it could
  bind any unclaimed term. `groundnut → cauliflower` would turn *no groundnuts* from a
  question the app asks into a filter it silently applies. That attacks the
  invariant itself. The human chose to narrow the route: it now binds only a term an
  unresolved draft line carries. Test
  [`2599c9f`](https://github.com/stuart-ohare/mise/commit/2599c9f), fix
  [`fe8208f`](https://github.com/stuart-ohare/mise/commit/fe8208f).

**Caught:** a dead end for the reviewer, and a route that let anyone decide what an
allergen-free search excludes.

## The limits

- **The git hooks are local.** They stop commits and pushes on `main` and enforce the
  commit format, but anyone with a shell can skip them.
- **Branch protection on `main` is the guarantee.** A PR is required, `checks` must pass,
  and admins aren't exempt.
- **The Claude Code hooks read shell text,** so indirection gets past them.
- **`pnpm eval` and the `invariant-reviewer` run only on a developer's machine.** No model
  runs in CI.
- **The traces rely partly on what the agent recorded.** A PR's *Invariant review*
  section, including the pass counts above, is written by the agent that ran the review.
  Nothing on GitHub re-runs it.

ADR 0003's [Cost accepted](decisions/0003-issue-driven-agentic-workflow.md#cost-accepted)
lists these gaps and the reasoning in full.
