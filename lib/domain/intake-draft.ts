import { z } from "zod";

import type { ResolutionIndex } from "./resolve-exclusions";

/**
 * What call 2 returns, and what Intake writes.
 *
 * The schema lives here rather than beside the prompt for the same reason
 * `constraintsSchema` does: it is the shape the HTTP boundary parses, and the prompt is
 * one of its consumers rather than its owner.
 */

const nonBlank = z.string().refine((value) => value.trim().length > 0, "must not be blank");

const score = z.number().min(0).max(1);

export const draftIngredientSchema = z.object({
  /** Never discarded, never rewritten: extraction is lossy and this is the audit trail. */
  rawText: nonBlank,
  /** The food alone, for resolution. Case and spacing are the index's business. */
  name: nonBlank,
  /** Null when the source states none. Never inferred — see the prompt. */
  qty: z.number().positive().nullable(),
  unit: nonBlank.nullable(),
  optional: z.boolean(),
  confidence: score,
});

export const draftRecipeSchema = z.object({
  title: nonBlank,
  serves: z.number().int().positive().nullable(),
  minutes: z.number().int().positive().nullable(),
  ingredients: z.array(draftIngredientSchema).min(1),
  steps: z.array(nonBlank).min(1),
  confidence: z.object({ title: score, serves: score, minutes: score }),
});

export type DraftRecipe = z.infer<typeof draftRecipeSchema>;

/**
 * Stored in `extraction_job.field_confidence`. Lines are keyed by `rawText` rather than
 * by position, so Review can render a score beside a line without two arrays having to
 * stay aligned.
 */
export type FieldConfidence = {
  title: number;
  serves: number;
  minutes: number;
  ingredients: { rawText: string; confidence: number }[];
};

export type IntakeIngredient = {
  canonicalId: string | null;
  canonicalName: string | null;
  rawText: string;
  qty: number | null;
  unit: string | null;
  optional: boolean;
  confidence: number;
};

export type IntakeDraft = {
  recipe: { title: string; serves: number | null; minutes: number | null; status: "draft" };
  ingredients: IntakeIngredient[];
  steps: { position: number; text: string }[];
  unresolved: string[];
  fieldConfidence: FieldConfidence;
};

export function buildIntakeDraft(
  _extracted: DraftRecipe,
  _index: ResolutionIndex,
  _names: ReadonlyMap<string, string>,
): IntakeDraft {
  return {
    recipe: { title: "", serves: null, minutes: null, status: "draft" },
    ingredients: [],
    steps: [],
    unresolved: [],
    fieldConfidence: { title: 0, serves: 0, minutes: 0, ingredients: [] },
  };
}
