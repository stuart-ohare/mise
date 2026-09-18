import { z } from "zod";

import { imageDataUriSchema } from "@/lib/domain/image-input";

/**
 * The Intake boundary, both directions, as the schemas the handler and the screen share
 * (CLAUDE.md §6). The response is parsed on the way out for the same reason Cook's is:
 * a pipeline that returned a shape the screen can't render should fail here, where it is
 * one stack trace, not there, where it is a blank page.
 */

/**
 * Two ways in, one field. `raw` is the string that lands in `extraction_job.raw_input`
 * whichever arm matched — the paste verbatim, or the photograph as a data URI — so
 * nothing downstream needs a second branch to know what to store.
 *
 * The discriminated union is what #71 left this as a literal for: adding the image arm
 * is a compile error at every branch that assumed text, rather than a value that quietly
 * falls through the text one.
 *
 * The two arms validate differently on purpose. A text `raw` is deliberately not
 * `.min(1)`: an empty paste is a pipeline outcome (`empty_input`), not a malformed
 * request, and 400 is reserved for a body that is neither shape — the rule
 * `POST /api/cook` already set for a blank query. An image `raw` is checked hard, because
 * an oversized or non-image payload is not an outcome anyone wants to spend a vision call
 * discovering.
 */
export const intakeRequestSchema = z.discriminatedUnion("sourceKind", [
  z.object({ sourceKind: z.literal("text"), raw: z.string() }),
  z.object({ sourceKind: z.literal("image"), raw: imageDataUriSchema }),
]);

export type IntakeRequest = z.infer<typeof intakeRequestSchema>;

const scoreSchema = z.number().min(0).max(1);

/**
 * What the screen renders. Every line carries `rawText` beside what it resolved to, and
 * `canonicalId: null` is a first-class value here rather than an omitted field — an
 * unresolved line is the thing the reviewer most needs to see.
 */
const intakeIngredientSchema = z.object({
  canonicalId: z.string().nullable(),
  canonicalName: z.string().nullable(),
  rawText: z.string().min(1),
  qty: z.number().positive().nullable(),
  unit: z.string().min(1).nullable(),
  optional: z.boolean(),
  confidence: scoreSchema,
});

const intakeDraftSchema = z.object({
  // Always `draft`, and typed as the literal so a route that published one wouldn't
  // compile, let alone parse (§2).
  recipe: z.object({
    title: z.string().min(1),
    serves: z.number().int().positive().nullable(),
    minutes: z.number().int().positive().nullable(),
    status: z.literal("draft"),
  }),
  ingredients: z.array(intakeIngredientSchema).min(1),
  steps: z.array(z.object({ position: z.number().int().positive(), text: z.string().min(1) })).min(1),
  unresolved: z.array(z.string().min(1)),
  fieldConfidence: z.object({
    title: scoreSchema,
    serves: scoreSchema,
    minutes: scoreSchema,
    ingredients: z.array(z.object({ rawText: z.string().min(1), confidence: scoreSchema })),
  }),
});

/**
 * Both outcomes in one union, so a client cannot render the draft and forget that
 * extraction can fail.
 *
 * - `draft` — the rows are written and awaiting review. `unresolved` is carried rather
 *   than re-derived, because what blocks this recipe from publishing is the answer, not
 *   a detail of it.
 * - `not_extracted` — call 2 failed. Nothing was written, so there is no job to show.
 */
export const intakeResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("draft"),
    jobId: z.string().min(1),
    recipeId: z.string().min(1),
    draft: intakeDraftSchema,
  }),
  z.object({
    kind: z.literal("not_extracted"),
    reason: z.enum(["empty_input", "refused", "parse_failed", "api_error"]),
  }),
]);

export type IntakeResponse = z.infer<typeof intakeResponseSchema>;
