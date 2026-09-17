# 2. Exclusion is a database constraint, not a model decision

**Status:** accepted
**Date:** 2026-09-17

## Context

The core request is natural language — *"no dairy, 25 minutes, and I can't face another
curry"* — and natural language is what models are for. The obvious build is to put the
catalogue in context and let the model answer.

Two of the three constraints in that sentence tolerate a wrong answer. The third does
not. An exclusion stated for a medical reason is a safety property, and safety
properties should not be enforced by a component whose output distribution is a
probability.

## Decision

The model parses intent and writes prose. It never decides what exists.

1. Constraint extraction returns a typed object. An exclusion that cannot be resolved
   to a canonical ingredient is asked about, never dropped.
2. SQL produces the candidate set — a `NOT EXISTS` over `recipe_ingredient` joined
   through the canonical ingredient tree, so butter is excluded by a `no dairy` query
   because butter's parent chain reaches dairy.
3. Generated prose is validated against the exclusion set before it renders. A
   violation is rejected, logged and retried once.

Allergens therefore hang off the canonical ingredient, not the recipe. A recipe is
dairy-free because none of its resolved ingredients carry the tag — derived, never
asserted. Nobody can mislabel a recipe, because nobody labels a recipe.

## Alternative considered

Semantic search over recipe embeddings. It would find better matches for fuzzy intent
like *"something comforting"*, and it is the right call for the **ranking** layer.

It is the wrong call for the **exclusion** layer, because a nearest-neighbour search
has no notion of *must not*. Retrieval quality is a product problem; exclusion is a
correctness problem. Different mechanisms.

Gate 3 in particular invites the objection that it is belt-and-braces, since gate 2
already guaranteed the rows. That is correct, and it still fires: the model summarises,
and summaries invent an ingredient that isn't in the recipe. The filter guarantees the
rows. Nothing guarantees the sentences except checking them.

## Cost accepted

Fuzzy intent is served worse than a pure-retrieval design would serve it, at this
catalogue size. Three gates instead of one is more code, more tests, and a slower path
to a first working demo. The exclusion eval threshold is pegged at 100%, which means a
failing fixture blocks a merge and the fix must be a better prompt or a narrower
schema — never a lowered bar.
