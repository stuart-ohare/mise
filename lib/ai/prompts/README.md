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

## Rules

- **Bump `VERSION` whenever the prompt text changes**, and re-run `pnpm eval`. An eval
  report you can't tie to a prompt version tells you nothing.
- The schema next to the prompt is the same schema the HTTP boundary uses. Parse, don't cast.
- Call 3 is constrained to the recipe IDs it was handed. Anything else is dropped before
  render — the model ranks and explains, it does not decide what exists.
- Call 2's central instruction is that an unstated quantity returns `null`. A plausible
  invented quantity is worse than a missing one, because a reviewer skims past it.
