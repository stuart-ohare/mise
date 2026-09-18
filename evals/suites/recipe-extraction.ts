import { z } from "zod";

import type { RecipeExtractionResult } from "@/lib/ai/prompts/extract-recipe";

import { expectedTermSchema } from "./constraint-extraction";

/**
 * Call 2 against hand-written sources, asking two questions that fail for different
 * reasons: did it read the fields the source states, and did it invent a value for a
 * field the source is silent about.
 */

/** One expected line. `qty` and `unit` are null when the source states none. */
export const expectedIngredientSchema = z.object({
  name: expectedTermSchema,
  qty: z.number().positive().nullable(),
  unit: z.string().min(1).nullable(),
});

export const recipeFixtureSchema = z.object({
  source: z.string().min(1),
  /** `null` means the source never states it — the value the model must not invent. */
  expected: z.object({
    title: z.string().min(1),
    serves: z.number().int().positive().nullable(),
    minutes: z.number().int().positive().nullable(),
    ingredients: z.array(expectedIngredientSchema).min(1),
  }),
});

export type RecipeFixture = z.infer<typeof recipeFixtureSchema>;

export interface ScoredRecipeRun {
  expected: RecipeFixture["expected"];
  result: RecipeExtractionResult;
}

export function scoreRecipeRuns(runs: readonly ScoredRecipeRun[]): Record<string, number> {
  void runs;
  return { field_accuracy: 0, null_precision: 0 };
}
