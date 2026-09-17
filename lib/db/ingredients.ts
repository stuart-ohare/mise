import { z } from "zod";

import type { Db } from "./client";
import { canonicalIngredient } from "./schema";
import type { IngredientNode } from "@/lib/domain/ingredient-tree";

/**
 * Gate 3's input. `outputTerms` holds generated prose to the same widened set of foods
 * gate 2 held the rows to, which needs the tree itself — a node's parent and its
 * allergen tags — not just the terms gate 1 matches on.
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

export async function loadIngredientTree(db: Executor): Promise<IngredientTree> {
  const nodes = await db
    .select({ id: canonicalIngredient.id, name: canonicalIngredient.name })
    .from(canonicalIngredient);

  return {
    nodes: z
      .array(nodeSchema)
      .parse(nodes.map((node) => ({ ...node, parentId: null, allergenTags: [] }))),
    aliases: [],
  };
}
