// Publishing is a write that changes what gate 2 can return, so it stays out of any
// client import graph for the same reason candidates.ts does.
import "server-only";

import { and, asc, eq, isNull, notExists, sql } from "drizzle-orm";

import type { Tx } from "./drafts";
import { extractionJob, recipe, recipeIngredient } from "./schema";

/**
 * The publish gate. A draft leaves draft only when none of its lines is unresolved,
 * optional lines included: an unknown ingredient is exactly where an allergen hides, and
 * once published a recipe is a row gate 2 can return (CLAUDE.md §2).
 *
 * It takes only the recipe id. What the review screen happened to render is not an
 * input, so a request from the page and one from curl get the same answer.
 */

export type UnresolvedLine = { id: string; rawText: string };

export type PublishResult =
  | { kind: "published" }
  | { kind: "not_found" }
  | { kind: "already_published" }
  | { kind: "unresolved"; lines: UnresolvedLine[] };

export async function publishDraft(tx: Tx, recipeId: string): Promise<PublishResult> {
  // The check and the write are one statement, so no line can change between the two.
  // Everything after it only explains a refusal.
  const [promoted] = await tx
    .update(recipe)
    .set({ status: "published" })
    .where(
      and(
        eq(recipe.id, recipeId),
        eq(recipe.status, "draft"),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(recipeIngredient)
            .where(and(eq(recipeIngredient.recipeId, recipe.id), isNull(recipeIngredient.canonicalId))),
        ),
      ),
    )
    .returning({ extractionJobId: recipe.extractionJobId });

  if (promoted) {
    // Seeded drafts have no job. An Intake draft's job moves with its recipe, so a
    // published recipe never points at a job still saying `awaiting_review`.
    if (promoted.extractionJobId !== null) {
      await tx
        .update(extractionJob)
        .set({ status: "promoted" })
        .where(eq(extractionJob.id, promoted.extractionJobId));
    }
    return { kind: "published" };
  }

  const [current] = await tx
    .select({ status: recipe.status })
    .from(recipe)
    .where(eq(recipe.id, recipeId));
  if (!current) return { kind: "not_found" };
  if (current.status === "published") return { kind: "already_published" };

  const lines = await tx
    .select({ id: recipeIngredient.id, rawText: recipeIngredient.rawText })
    .from(recipeIngredient)
    .where(and(eq(recipeIngredient.recipeId, recipeId), isNull(recipeIngredient.canonicalId)))
    .orderBy(asc(recipeIngredient.id));

  // A draft the update refused with no unresolved line would be a refusal that names no
  // reason. That is a bug in the predicate above, not an outcome to report.
  if (lines.length === 0) {
    throw new Error(`publish of draft ${recipeId} was refused with no unresolved line`);
  }
  return { kind: "unresolved", lines };
}
