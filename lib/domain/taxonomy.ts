import { z } from "zod";

export const ALLERGENS = ["dairy", "gluten", "nuts", "shellfish", "egg", "soy"] as const;

export const taxonomySchema = z.object({
  nodes: z.array(
    z.object({
      name: z.string(),
      parent: z.string().nullable(),
      allergenTags: z.array(z.string()),
      aliases: z.array(z.string()),
    }),
  ),
});

export type Taxonomy = z.infer<typeof taxonomySchema>;
export type TaxonomyNode = Taxonomy["nodes"][number];

export type TaxonomyValidation =
  | { ok: true; nodes: TaxonomyNode[] }
  | { ok: false; errors: string[] };

export function validateTaxonomy(taxonomy: Taxonomy): TaxonomyValidation {
  return { ok: true, nodes: taxonomy.nodes };
}
