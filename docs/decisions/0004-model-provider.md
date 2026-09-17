# 4. Model provider: Anthropic, called directly

**Status:** accepted
**Date:** 2026-09-17

## Context

Mise makes three model calls: constraint extraction, recipe extraction, and ranking with
an explanation. Every one returns output that a Zod schema parses before anything else
touches it. Recipe extraction also reads photographs of handwritten cards. The brief asks
*why this model*, and the answer should be about the job, not the vendor.

## Decision

Anthropic, through `@anthropic-ai/sdk` used directly, with two tiers named in
`lib/ai/client.ts`: `MODELS.fast` for constraint extraction and `MODELS.capable` for
recipe extraction and ranking. The model IDs live there, not here.

1. **Output that fits a schema.** Every call is parsed at the boundary, so a model that
   drifts from the schema costs a retry on every request.
2. **Two sizes on one API.** Constraint extraction is short, frequent and cheap to get
   wrong. Recipe extraction is long, messy and expensive to get wrong. One model for
   both would be either slow or sloppy.
3. **Vision on the same API.** The handwritten-card path needs no second integration.
4. **One vendor across the build.** Claude Code writes this repository and runs the
   local `invariant-reviewer`, so the build has one key, one bill and one set of model
   quirks. This is a practical reason, not a claim about quality.

None of reasons 1–3 is unique to Anthropic. What makes the choice defensible without a
benchmark is [ADR 0002](0002-exclusion-is-a-database-constraint.md): the model never
decides what is excluded. SQL filters the rows and the output check scans the prose, so
a weaker model shows up as more retries and more cards without prose, not as an allergen
reaching the screen. The provider affects quality and cost. It does not affect safety.

## Alternative considered

A provider-agnostic client: the Vercel AI SDK, optionally through AI Gateway, where
switching providers means changing a model string. It is the obvious objection, since the
app deploys on Vercel.

It lost for three reasons:

- It is the model-client wrapper CLAUDE.md §2 rules out, and a dependency someone has
  to defend.
- Being able to switch providers is only worth something once an eval run says to switch.
  Without that run, the flexibility is speculative. The swap stays small without a
  wrapper: today the SDK is imported in one file, it grows by one call site per prompt,
  and Zod parses every output whichever provider produced it.
- Schema-constrained output and vision are where providers differ most. A common
  interface smooths over exactly the features the Zod boundary relies on.

## Cost accepted

**The provider was chosen by reasoning, not measurement.** No other provider has been run
against Mise's fixtures, and the eval suite that would do it is defined in
[`evals/README.md`](../../evals/README.md) but not yet built. The decision should change
if another provider, on the same fixtures, meets every hard threshold and is cheaper or
better on the rest:

- exclusion accuracy on constraint extraction — 100%;
- null-precision on recipe extraction — 100%;
- violations reaching render on output safety — 0.

Only a provider that meets all three gets compared on F1, field accuracy and cost per
Cook request.

Switching means editing `lib/ai/client.ts` and each prompt's call site, not changing a
config value. That is about a day's work, and it grows a little with each call that lands.
