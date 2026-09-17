import { z } from "zod";

import type { IngredientNode } from "@/lib/domain/ingredient-tree";

import type { Db } from "./client";
import { canonicalIngredient, ingredientAlias } from "./schema";

/**
 * Gate 3's input. `outputTerms` holds generated prose to the same widened set of foods
 * gate 2 held the rows to, which needs the tree itself — a node's parent and its
 * allergen tags — not just the terms gate 1 matches on.
 *
 * `loadResolutionTerms` stays gate 1's loader rather than being derived from this one.
 * The cost is two reads of the same two tables that have to agree on what "every term"
 * is, so `ingredients.db.test.ts` pins them against each other.
 */

type Executor = Pick<Db, "select">;

const nodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  allergenTags: z.array(z.string()),
});

export const aliasSchema = z.object({ canonicalId: z.string(), alias: z.string() });

export type IngredientAlias = z.infer<typeof aliasSchema>;
export type IngredientTree = { nodes: IngredientNode[]; aliases: IngredientAlias[] };

/**
 * Two selects, concurrently. No filtering and no ordering guarantee: `exclusionIds` and
 * `outputTerms` both walk the whole list, and a partial tree is the one thing that would
 * make them fail open — a missing parent silently narrows an exclusion.
 */
export async function loadIngredientTree(db: Executor): Promise<IngredientTree> {
  const [nodes, aliases] = await Promise.all([
    db
      .select({
        id: canonicalIngredient.id,
        name: canonicalIngredient.name,
        parentId: canonicalIngredient.parentId,
        allergenTags: canonicalIngredient.allergenTags,
      })
      .from(canonicalIngredient),
    db
      .select({
        canonicalId: ingredientAlias.canonicalId,
        alias: ingredientAlias.alias,
      })
      .from(ingredientAlias),
  ]);

  return {
    nodes: z.array(nodeSchema).parse(nodes),
    aliases: z.array(aliasSchema).parse(aliases),
  };
}
