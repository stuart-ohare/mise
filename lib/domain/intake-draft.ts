import { z } from "zod";

import { normaliseTerm, type ResolutionIndex } from "./resolve-exclusions";

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

/**
 * Gate 1 for Intake: each extracted line resolved against the canonical index, or left
 * explicitly unresolved.
 *
 * `names` maps a canonical id to its name, only so the screen can say what a line
 * resolved to. Resolution itself never reads it — a line's id comes from the index and
 * nowhere else.
 */
export function buildIntakeDraft(
  extracted: DraftRecipe,
  index: ResolutionIndex,
  names: ReadonlyMap<string, string>,
): IntakeDraft {
  const ingredients = extracted.ingredients.map((line): IntakeIngredient => {
    // Exact after normalisation, as gate 1 is everywhere else: a near miss belongs in
    // review, because a guessed match is how an allergen gets filed under the wrong node.
    const canonicalId = index.get(normaliseTerm(line.name)) ?? null;
    return {
      canonicalId,
      canonicalName: canonicalId === null ? null : (names.get(canonicalId) ?? null),
      rawText: line.rawText,
      qty: line.qty,
      unit: line.unit,
      optional: line.optional,
      confidence: line.confidence,
    };
  });

  return {
    recipe: {
      title: extracted.title,
      serves: extracted.serves,
      minutes: extracted.minutes,
      // Always draft, whatever resolved and whatever the scores say. `deriveRecipeStatus`
      // publishes a fully-resolved recipe, which is right for the committed catalogue and
      // wrong for extraction: a human promotes an intake draft from /review (§2).
      status: "draft",
    },
    ingredients,
    steps: extracted.steps.map((text, i) => ({ position: i + 1, text })),
    unresolved: ingredients.flatMap((i) => (i.canonicalId === null ? [i.rawText] : [])),
    fieldConfidence: {
      ...extracted.confidence,
      ingredients: extracted.ingredients.map(({ rawText, confidence }) => ({ rawText, confidence })),
    },
  };
}
