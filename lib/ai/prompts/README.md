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
- **Exclude wins.** A food that is excluded anywhere in the request goes in `exclude`
  only, even when the same request also says the cook is tired of it or has it in.
- **Carve-outs never narrow an exclusion.** "No dairy but butter is fine" is
  `exclude: ["dairy"]`, and butter appears nowhere.
- **Output is parsed twice.** The SDK checks a plain model schema, because structured
  output can't express `.min(1)` or `.positive()`. Then `constraintsSchema` parses the
  result. A truncated response (`max_tokens`) is `parse_failed` even if it parses,
  because it may have lost an exclusion.

## Rules

- **Bump `VERSION` whenever the prompt text changes**, and re-run `pnpm eval`. An eval
  report you can't tie to a prompt version tells you nothing.
- The schema next to the prompt is the same schema the HTTP boundary uses. Parse, don't cast.
- Call 3 is constrained to the recipe IDs it was handed. Anything else is dropped before
  render — the model ranks and explains, it does not decide what exists.
- Call 2's central instruction is that an unstated quantity returns `null`. A plausible
  invented quantity is worse than a missing one, because a reviewer skims past it.
