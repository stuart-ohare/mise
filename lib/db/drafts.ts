import { z } from "zod";

import type { FieldConfidence, IntakeDraft } from "@/lib/domain/intake-draft";

import type { Db } from "./client";
import { extractionJob, recipe, recipeIngredient, recipeStep } from "./schema";

/**
 * Intake's write: one `extraction_job` and the draft recipe it produced.
 *
 * It takes a transaction rather than the connection, as `seedDatabase` does, so the
 * caller decides the boundary — the route opens one, and the database test opens one it
 * rolls back. Four tables have to land together or not at all: a job with no recipe is
 * an empty row in the queue, and a recipe with no job is a draft with no audit trail.
 */

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type IntakeWrite = {
  sourceKind: "text" | "image";
  /**
   * What arrived, verbatim — the paste, or the photograph as a data URI. `raw_text` is
   * never the only record of what was read.
   */
  rawInput: string;
  model: string;
  promptVersion: string;
  /** The parsed model output, stored whole so a reviewer can see what it said. */
  output: unknown;
  draft: IntakeDraft;
};

export type IntakeWritten = { jobId: string; recipeId: string };

export async function writeIntakeDraft(tx: Tx, input: IntakeWrite): Promise<IntakeWritten> {
  const { draft } = input;

  const [job] = await tx
    .insert(extractionJob)
    .values({
      sourceKind: input.sourceKind,
      rawInput: input.rawInput,
      model: input.model,
      promptVersion: input.promptVersion,
      output: input.output,
      fieldConfidence: draft.fieldConfidence,
      // Not `pending`: the extraction is done by the time this row exists, and the only
      // thing left is a human looking at it. No threshold moves it past here (§2).
      status: "awaiting_review",
    })
    .returning({ id: extractionJob.id });
  if (!job) throw new Error("extraction_job insert returned no row");

  const [row] = await tx
    .insert(recipe)
    .values({ ...draft.recipe, extractionJobId: job.id })
    .returning({ id: recipe.id });
  if (!row) throw new Error(`insert of "${draft.recipe.title}" returned no row`);

  await tx.insert(recipeIngredient).values(
    draft.ingredients.map((line) => ({
      recipeId: row.id,
      canonicalId: line.canonicalId,
      rawText: line.rawText,
      // `numeric` is written as text so a decimal quantity survives the round trip
      // intact; null stays null, because an unstated amount is not a zero.
      qty: line.qty === null ? null : String(line.qty),
      unit: line.unit,
      optional: line.optional,
    })),
  );

  if (draft.steps.length > 0) {
    await tx.insert(recipeStep).values(draft.steps.map((step) => ({ ...step, recipeId: row.id })));
  }

  return { jobId: job.id, recipeId: row.id };
}

const fieldConfidenceSchema: z.ZodType<FieldConfidence> = z.object({
  title: z.number(),
  serves: z.number(),
  minutes: z.number(),
  ingredients: z.array(z.object({ rawText: z.string(), confidence: z.number() })),
});

// `status` is pinned rather than read: a published row reaching the queue fails the
// parse, even from a caller no test covers.
const draftRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  minutes: z.number().int().nullable(),
  serves: z.number().int().nullable(),
  status: z.literal("draft"),
  extractionJobId: z.string().nullable(),
  extractionJob: z.object({ fieldConfidence: z.unknown() }).nullable(),
  ingredients: z.array(
    z.object({
      rawText: z.string(),
      canonicalId: z.string().nullable(),
      // `numeric` arrives as text. It stays text: the screen only shows it, and a
      // string keeps the decimal exactly as written.
      qty: z.string().nullable(),
      unit: z.string().nullable(),
      optional: z.boolean(),
      canonical: z.object({ name: z.string() }).nullable(),
    }),
  ),
});

export type QueueLine = {
  rawText: string;
  canonicalId: string | null;
  /** The canonical row's name, never extraction's word for it. Null when unresolved. */
  canonicalName: string | null;
  qty: string | null;
  unit: string | null;
  optional: boolean;
};

export type QueuedDraft = {
  id: string;
  title: string;
  minutes: number | null;
  serves: number | null;
  status: "draft";
  source: "intake" | "seed";
  /** Null for a seeded draft: nothing was extracted, so there is no score to show. */
  fieldConfidence: FieldConfidence | null;
  lines: QueueLine[];
};

/**
 * Review's queue: every draft, each line's `raw_text` beside what it resolved to.
 *
 * Its own query rather than a mode of `findCandidateRecipes`, which selects published
 * rows only. Widening that to serve both would leave a draft one missing predicate away
 * from a Cook result.
 */
export async function listDrafts(db: Db | Tx): Promise<QueuedDraft[]> {
  const rows = await db.query.recipe.findMany({
    columns: { id: true, title: true, minutes: true, serves: true, status: true, extractionJobId: true },
    where: (r, { eq }) => eq(r.status, "draft"),
    orderBy: (r, { asc, desc }) => [desc(r.createdAt), asc(r.title)],
    with: {
      extractionJob: { columns: { fieldConfidence: true } },
      ingredients: {
        columns: { rawText: true, canonicalId: true, qty: true, unit: true, optional: true },
        with: { canonical: { columns: { name: true } } },
      },
    },
  });

  return z.array(draftRowSchema).parse(rows).map((row) => ({
    id: row.id,
    title: row.title,
    minutes: row.minutes,
    serves: row.serves,
    status: row.status,
    source: row.extractionJobId === null ? "seed" : "intake",
    fieldConfidence:
      row.extractionJob === null
        ? null
        : fieldConfidenceSchema.nullable().parse(row.extractionJob.fieldConfidence),
    lines: row.ingredients
      .map(({ canonical, ...line }) => ({ ...line, canonicalName: canonical?.name ?? null }))
      .sort(unresolvedFirst),
  }));
}

/**
 * `recipe_ingredient` has no position column, so there is no recipe order to keep. The
 * line blocking publication goes to the top instead; the rest are alphabetical.
 */
function unresolvedFirst(a: QueueLine, b: QueueLine): number {
  const blocked = Number(b.canonicalId === null) - Number(a.canonicalId === null);
  return blocked !== 0 ? blocked : a.rawText.localeCompare(b.rawText);
}
