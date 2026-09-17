import { z } from "zod";

import { taxonomyNodeSchema, term } from "@/lib/domain/taxonomy";

export const DELIBERATELY_UNRESOLVED = ["ghee", "panko", "brinjal"] as const;

export const leafSchema = taxonomyNodeSchema.extend({
  allergenTags: z.array(z.string()).length(0),
  aliases: z.array(term).length(0),
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
  adversarialCase: z.enum(["optional-butter", "near-duplicate", "unresolved"]).nullable(),
  duplicateOf: z.string().min(1).nullable(),
});

export const recipesSchema = z.object({ recipes: z.array(recipeSchema) });
