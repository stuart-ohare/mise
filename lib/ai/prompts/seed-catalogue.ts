import { z } from "zod";

import { taxonomyNodeSchema, term, type TaxonomyNode } from "@/lib/domain/taxonomy";

/**
 * The one-off catalogue generation call (`scripts/seed/generate.ts`). Offline, capable
 * model, never called by the app or by `pnpm seed`.
 *
 * The model fills recipes and leaf ingredients. It never writes an allergen tag: the
 * leaf it returns has no field for one, so a generated ingredient can only inherit a
 * tag from the hand-authored node it attaches under.
 */

export const VERSION = "1";

/**
 * Real ingredients deliberately absent from every name and alias, so a fresh install has
 * recipes in draft. `brinjal` is South Asian and South African English for aubergine.
 */
export const DELIBERATELY_UNRESOLVED = ["ghee", "panko", "brinjal"] as const;

export const ADVERSARIAL_CASES = ["optional-butter", "near-duplicate", "unresolved"] as const;

// ——— Committed file schemas: what `pnpm seed` parses. ———

// Empty by construction: a generated leaf can only inherit a tag, never assert one.
export const leafSchema = taxonomyNodeSchema.extend({
  allergenTags: z.array(z.never()).length(0),
  aliases: z.array(z.never()).length(0),
});

export const leavesSchema = z.object({ nodes: z.array(leafSchema) });

export const recipeIngredientSchema = z.object({
  rawText: z.string().trim().min(1),
  name: term,
  qty: z.number().positive().nullable(),
  unit: z.string().min(1).nullable(),
  optional: z.boolean(),
});

export const recipeSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  minutes: z.number().int().positive(),
  serves: z.number().int().positive(),
  ingredients: z.array(recipeIngredientSchema).min(1),
  steps: z.array(z.string().min(1)).min(1),
  adversarialCase: z.enum(ADVERSARIAL_CASES).nullable(),
  duplicateOf: z.string().min(1).nullable(),
});

export const recipesSchema = z.object({
  recipes: z.array(recipeSchema).refine(
    (recipes) => new Set(recipes.map((r) => r.title.toLowerCase())).size === recipes.length,
    "recipe titles must be unique — the loader skips a title that already exists",
  ),
});

export type Recipe = z.infer<typeof recipeSchema>;
export type Leaf = z.infer<typeof leafSchema>;

// ——— Model output schema: what the API call is constrained to. ———

// Structured output can't express refinements or transforms, so the model gets a plain
// shape and every batch is then parsed with the file schemas above before it is kept.
export const catalogueBatchSchema = z.object({
  recipes: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      minutes: z.number().int(),
      serves: z.number().int(),
      ingredients: z.array(
        z.object({
          rawText: z.string(),
          name: z.string(),
          qty: z.number().nullable(),
          unit: z.string().nullable(),
          optional: z.boolean(),
        }),
      ),
      steps: z.array(z.string()),
      adversarialCase: z.enum(ADVERSARIAL_CASES).nullable(),
      duplicateOf: z.string().nullable(),
    }),
  ),
  leaves: z.array(z.object({ name: z.string(), parent: z.string().nullable() })),
});

export type CatalogueBatch = z.infer<typeof catalogueBatchSchema>;

export const SYSTEM = `You write recipes for a synthetic recipe catalogue used to test a cooking app for households where someone has a hard dietary exclusion (dairy, gluten, nuts, shellfish, egg, soy). The recipes must be realistic home cooking: accurate quantities, sensible times, clear steps.

Every recipe ingredient has:
- rawText: the full line as a recipe would print it, e.g. "2 tbsp olive oil".
- name: the ingredient alone, lowercase, singular where natural, e.g. "olive oil". This is matched exactly against a canonical ingredient list, so it must be one of: a canonical name or alias from the taxonomy you are given, a leaf already defined, or a new leaf you define in this response.
- qty and unit: null when a recipe would not state them ("salt, to taste").
- optional: true only for a garnish or finishing touch the dish works without.

Leaves:
- For every ingredient name that is not already in the taxonomy or the existing leaves, return a leaf: { name, parent }.
- If the ingredient is, or is made from, dairy, gluten grains, nuts or peanuts, shellfish or molluscs, egg, or soy, parent MUST be the most specific taxonomy node it belongs under (e.g. parmesan under cheese, sourdough under bread, spaghetti under pasta, tahini is NOT a nut). Otherwise parent is null.
- A leaf must be a single ingredient containing at most one of those allergens. Do not create prepared or compound ingredients that contain two (pesto, naan, hoisin sauce, peanut butter cookies): list their components instead, or use a taxonomy node that already exists.
- Never use a taxonomy name or alias as a leaf name. Never create leaves for these words, and never list them as a leaf of any kind: ${DELIBERATELY_UNRESOLVED.join(", ")}.

adversarialCase is null unless the brief asks for a specific case. duplicateOf is null unless adversarialCase is "near-duplicate".`;

export function batchPrompt(input: {
  taxonomy: readonly TaxonomyNode[];
  leaves: readonly { name: string; parent: string | null }[];
  existing: readonly Pick<Recipe, "title" | "ingredients">[];
  count: number;
  brief: string;
}): string {
  const taxonomy = input.taxonomy
    .map((n) => `- ${n.name}${n.parent ? ` (under ${n.parent})` : ""}${n.aliases.length ? `; aliases: ${n.aliases.join(", ")}` : ""}`)
    .join("\n");
  const leaves = input.leaves.length
    ? input.leaves.map((l) => `- ${l.name}${l.parent ? ` (under ${l.parent})` : ""}`).join("\n")
    : "(none yet)";
  const existing = input.existing.length
    ? input.existing.map((r) => `- ${r.title}: ${r.ingredients.map((i) => i.name).join(", ")}`).join("\n")
    : "(none yet)";

  return `Taxonomy (hand-authored; allergen roots and their children):
${taxonomy}

Leaves already defined (reuse these names exactly):
${leaves}

Recipes already written (do not repeat a title or a dish):
${existing}

Write exactly ${input.count} new recipes.

${input.brief}`;
}

export const BATCH_BRIEFS = [
  `This batch must include these specific cases, and otherwise be varied weeknight cooking:
1. adversarialCase "optional-butter": a savoury dish with an innocent title that suggests nothing about dairy (no butter, cream, cheese, milk or similar in the title or summary). Its ONLY dairy ingredient is butter, with name exactly "butter", optional: true, used in an optional finishing step ("finish with a knob of butter, if you like"). Every other ingredient must be free of all dairy. Use no ghee, panko or brinjal in it.
2. adversarialCase "unresolved": one recipe with an ingredient whose name is exactly "ghee" (e.g. a dal or a pilau).
3. adversarialCase "unresolved": one recipe with an ingredient whose name is exactly "panko" (e.g. a crumbed fish or katsu).
4. adversarialCase "unresolved": one recipe with an ingredient whose name is exactly "brinjal" (e.g. a South Indian or South African brinjal curry or bake).
Apart from those three words, every ingredient name must be resolvable as described.`,
  `This batch must include one recipe with adversarialCase "near-duplicate": a near-duplicate of one of the recipes already written (set duplicateOf to its exact title). Give it a slightly different title and the same method, but name at least one ingredient differently using a taxonomy alias instead of the name the original used (for example "shrimp" where the original said "prawn", "yogurt" for "yoghurt", "soya sauce" for "soy sauce"). The rest of the batch: varied weeknight cooking, including at least three quick (25 minutes or less) dairy-free dishes that use cauliflower.`,
  `Varied cooking with a spread of cuisines. Include several gluten-free, egg-free and nut-free dishes, some dishes that do use nuts, shellfish, egg or soy as a main ingredient, and one dish with egg pasta.`,
  `Varied cooking to round out the catalogue: some curries and some explicitly non-curry comfort food, a few baked dishes and desserts, and a range of times from 10 to 90 minutes.`,
] as const;

export const RECIPES_PER_BATCH = 15;
