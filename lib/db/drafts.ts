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
  /** The paste, verbatim. `raw_text` is never the only record of what was read. */
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
      sourceKind: "text",
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

export type QueueLine = {
  rawText: string;
  canonicalId: string | null;
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
  fieldConfidence: FieldConfidence | null;
  lines: QueueLine[];
};

export async function listDrafts(_db: Db | Tx): Promise<QueuedDraft[]> {
  return [];
}
