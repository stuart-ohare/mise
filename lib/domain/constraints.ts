import { z } from "zod";

/**
 * What a Cook request means, as a typed object. Constraint extraction (call 1)
 * returns exactly this shape, and the HTTP boundary parses with the same schema.
 *
 * `exclude` and `avoid` are deliberately separate fields. `exclude` becomes a
 * `NOT EXISTS` in SQL (gate 2) and is never traded off. `avoid` is only a ranking
 * weight. Collapsing them would turn an allergen into a preference.
 */
export const constraintsSchema = z.object({
  /** Hard exclusions — "no dairy", "they can't do gluten". Filtered in SQL. */
  exclude: z.array(z.string().min(1)),
  /** Soft avoidance — "not another curry", "had pasta twice this week". Ranking only. */
  avoid: z.array(z.string().min(1)),
  /** Ingredients on hand — "half a cauliflower". */
  have: z.array(z.string().min(1)),
  /** "25 minutes", "under half an hour". Null when unstated, never guessed. */
  maxMinutes: z.number().int().positive().nullable(),
});

export type Constraints = z.infer<typeof constraintsSchema>;

/**
 * Gate 1. An exclusion either resolves to a canonical ingredient or is surfaced
 * to the user as a question. There is no third outcome where it is dropped.
 */
export type ExclusionResolution =
  | { kind: "resolved"; term: string; canonicalId: string }
  | { kind: "unresolved"; term: string };
