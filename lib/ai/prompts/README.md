# Prompts

Every prompt in this application lives in this directory, as a named export with its
output schema beside it and a `VERSION` constant. Nothing is inlined in a route handler.

Three calls, each with one narrow job:

| File | Call | Model | Job |
|---|---|---|---|
| `extract-constraints.ts` | 1 | fast | Free text → typed constraints. No retrieval, no catalogue in context. |
| `extract-recipe.ts` | 2 | capable | Messy text or an image → a draft recipe with per-field confidence. Must never guess. |
| `rank-and-explain.ts` | 3 | capable | Pre-filtered candidate rows → ordered recipe IDs with a one-line rationale each. |
| `seed-catalogue.ts` | offline | capable | One-off catalogue generation for `scripts/seed/`. Never called by the app or `pnpm seed`. |

## Call 1 — `extract-constraints.ts`

`extractConstraints(query)` returns `{ ok: true, constraints }` or
`{ ok: false, reason }`. The reason is `empty_query`, `refused`, `parse_failed` or
`api_error`. It never retries. **It fails closed:** a failure never becomes
`exclude: []`, because gate 1 can only ask about exclusions it is handed.

- **Vocabulary.** The prompt names only the six allergen roots, taken from `ALLERGENS`.
  A whole-group exclusion ("dairy-free") uses the root name. Anything else is the food
  as a bare noun in the user's words. No taxonomy is in context: a term that doesn't
  resolve is gate 1's to ask about.
- **If in doubt, exclude.** Any statement that a named food shouldn't be eaten goes in
  `exclude`, hedged or not, including dislikes. `avoid` is only for fatigue, mood or
  history.
- **Exclude wins, in code.** A food that is excluded anywhere in the request belongs in
  `exclude` only, even when the request also says the cook is tired of it or has it in.
  The prompt asks for this and the model doesn't always comply — on the salmon fixture it
  listed the food in both fields in three runs of three — so after parsing, any term that
  is also excluded is removed from `avoid` and `have`. `exclude` itself is never touched.
- **Carve-outs never narrow an exclusion.** "No dairy but butter is fine" is
  `exclude: ["dairy"]`, and butter appears nowhere.
- **Output is parsed twice.** The SDK checks a plain model schema, because structured
  output can't express `.min(1)` or `.positive()`. Then `constraintsSchema` parses the
  result. A truncated response (`max_tokens`) is `parse_failed` even if it parses,
  because it may have lost an exclusion.

## Call 3 — `rank-and-explain.ts`

`rankAndExplain({ candidates, constraints }, client?, violatedTerms?)` returns
`{ ok: true, ranking, dropped }` or `{ ok: false, reason }`, where reason is
`no_candidates`, `no_valid_ids`, `refused`, `parse_failed` or `api_error`. `ranking` is
at most `MAX_RESULTS` (5) entries of `{ id, rationale }`, in the model's order. It never
retries — that is gate 3's job, and this function is the `generate` that
`runOutputGate` drives.

- **The drop is code, not prompt.** The prompt asks the model to copy ids from the rows
  it was given; `keepKnownIds` is what guarantees it. Ids are matched case-insensitively
  and re-emitted in the candidate's own spelling, duplicates keep their first position,
  and truncation to five happens *after* the drop so an invented id can never push out a
  real recipe.
- **An all-invented response is a failure.** `no_valid_ids`, never `ok: true` with an
  empty list: "nothing suits you" and "the model made this up" are different answers.
- **The drop is counted, not silent.** `dropped` names each invented id once, in the
  spelling the model first used, and rides on the `ok: true` result and on `no_valid_ids`
  — the two outcomes where a response existed to fabricate in. An empty `dropped` beside a
  short `ranking` means fewer candidates suited; a non-empty one means the model invented
  rows. It is a value rather than a sink like gate 3's `onViolation`, which exists only
  because that gate destroys what it rejects. **Gate 3 scans `ranking`, not the whole
  result** — see the `RankingResult` comment for why. Nothing consumes it yet: there is no
  cook route.
- **Excluded foods are named in the prompt as words never to write.** Gate 3 doesn't
  parse negation, so "a dairy-free take" is a violation — the rows are already safe, so
  there is nothing to reassure the cook about. `violatedTerms` travels in the request
  payload as `forbidden`, which is the only difference between attempt 1 and the retry.
- **The row shape is gate 2's.** `rankingCandidateSchema` extends `candidateRecipeSchema`
  from `lib/db/candidates.ts` with the ingredient names, so the compiler rejects a call 3
  that has drifted from what the query returns. Nothing re-parses the rows at runtime:
  they arrive from gate 2, not across a boundary, and the boundary that does need a parse
  is the route's. Selecting those names is the caller's job.
- **Static `SYSTEM`, variable payload.** Rules in the system prompt, candidates and
  constraints in the user message, so `VERSION` tracks rule changes and not requests.

## Rules

- **Bump `VERSION` whenever the prompt text changes**, and re-run `pnpm eval`. An eval
  report you can't tie to a prompt version tells you nothing.
- The schema next to the prompt is the same schema the HTTP boundary uses. Parse, don't cast.
- Call 3 is constrained to the recipe IDs it was handed. Anything else is dropped before
  render — the model ranks and explains, it does not decide what exists.
- Call 2's central instruction is that an unstated quantity returns `null`. A plausible
  invented quantity is worse than a missing one, because a reviewer skims past it.
