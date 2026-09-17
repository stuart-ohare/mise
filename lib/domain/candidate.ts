import { z } from "zod";

/**
 * The shape of a gate 2 row: what a candidate recipe looks like once SQL has decided
 * it exists. Shared by the query that produces it, the model call that ranks it, the
 * HTTP boundary and the screen — the same schema at every one, as CLAUDE.md §6 asks.
 *
 * It lives here rather than beside the query because the Cook screen is a client
 * component and needs this shape, while gate 2's recursive CTE must stay out of its
 * import graph. Nothing in this file may import a database module or drizzle-orm;
 * app/_components/cook-client.imports.test.ts is what keeps that true.
 */
export const candidateRecipeSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  minutes: z.number().int().nullable(),
  serves: z.number().int().nullable(),
});

export type CandidateRecipe = z.infer<typeof candidateRecipeSchema>;
