import { unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Db } from "./client";
import { canonicalIngredient, ingredientAlias } from "./schema";

/**
 * Gate 1's input. Every canonical name and every alias, as the entries
 * `buildResolutionIndex` takes — so an exclusion term can be resolved inside a
 * request rather than only in tests and the seed script.
 *
 * Names and aliases share one namespace because gate 1 resolves a term against both,
 * so they come back as one flat list. What a term claimed twice means is
 * `buildResolutionIndex`'s decision, not this query's: it drops the term, the user is
 * asked, and no exclusion is silently bound to the wrong ingredient.
 */

type Executor = Pick<Db, "select">;

const resolutionTermSchema = z.object({
  term: z.string(),
  canonicalId: z.string(),
});

export type ResolutionTerm = z.infer<typeof resolutionTermSchema>;

/**
 * One round trip. `unionAll` rather than `union`: deduping is the index builder's
 * business, and a duplicated row cannot change the index it builds.
 */
export async function loadResolutionTerms(db: Executor): Promise<ResolutionTerm[]> {
  const names = db
    .select({ term: canonicalIngredient.name, canonicalId: canonicalIngredient.id })
    .from(canonicalIngredient);
  const aliases = db
    .select({ term: ingredientAlias.alias, canonicalId: ingredientAlias.canonicalId })
    .from(ingredientAlias);

  return z.array(resolutionTermSchema).parse(await unionAll(names, aliases));
}
