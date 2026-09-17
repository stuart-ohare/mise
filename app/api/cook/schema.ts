import { z } from "zod";

import { candidateRecipeSchema } from "@/lib/db/candidates";
import { constraintsSchema } from "@/lib/domain/constraints";

/**
 * The Cook boundary, both directions, as the schemas the handler and the screen share
 * (CLAUDE.md §6). Parsing the response on the way out is not ceremony: it is what stops
 * a pipeline change returning a shape the screen never learned to render.
 */

/**
 * Two request shapes. `query` runs constraint extraction; `constraints` skips it and is
 * what a corrected chip posts, so a misread exclusion can be fixed without retyping the
 * sentence.
 *
 * A client-supplied `exclude` is resolved by gate 1 and filtered by gate 2 exactly as an
 * extracted one is. Nothing here can bypass a gate; it can only change which exclusions
 * apply, which is the cook's decision to make.
 */
export const cookRequestSchema = z.discriminatedUnion("kind", [
  // Deliberately not `.min(1)`: a blank query is a pipeline outcome (`empty_query`),
  // not a malformed request, and 400 is reserved for a body that is neither shape.
  z.object({ kind: z.literal("query"), query: z.string() }),
  z.object({ kind: z.literal("constraints"), constraints: constraintsSchema }),
]);

export type CookRequest = z.infer<typeof cookRequestSchema>;

const rankedResultSchema = z.object({
  recipe: candidateRecipeSchema,
  rationale: z.string().min(1),
});

/**
 * Every outcome in one union, so a client cannot handle the happy path and forget
 * `needs_resolution` — an unhandled `kind` is a type error rather than a blank screen.
 *
 * - `ranked` — prose survived gate 3.
 * - `cards` — safe rows without prose. `output_violation` is gate 3 rejecting both
 *   attempts; `ranking_unavailable` is call 3 failing. The rows are still correct, so
 *   losing the prose is the cost the architecture exists to be able to pay.
 * - `needs_resolution` — an exclusion gate 1 could not map. No rows, by design.
 * - `no_candidates` — nothing survived. `relaxTime` is the one constraint worth
 *   offering back, and only when relaxing it would actually help.
 * - `not_understood` — constraint extraction itself failed.
 */
export const cookResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ranked"),
    constraints: constraintsSchema,
    results: z.array(rankedResultSchema),
    attempts: z.union([z.literal(1), z.literal(2)]),
  }),
  z.object({
    kind: z.literal("cards"),
    constraints: constraintsSchema,
    results: z.array(candidateRecipeSchema),
    reason: z.enum(["output_violation", "ranking_unavailable"]),
  }),
  z.object({
    kind: z.literal("needs_resolution"),
    constraints: constraintsSchema,
    unresolved: z.array(z.string().min(1)),
  }),
  z.object({
    kind: z.literal("no_candidates"),
    constraints: constraintsSchema,
    relaxTime: z
      .object({ limit: z.number().int().positive(), wouldMatch: z.number().int().positive() })
      .nullable(),
  }),
  z.object({
    kind: z.literal("not_understood"),
    reason: z.enum(["empty_query", "refused", "parse_failed", "api_error"]),
  }),
]);

export type CookResponse = z.infer<typeof cookResponseSchema>;
