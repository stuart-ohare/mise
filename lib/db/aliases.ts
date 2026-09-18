// Re-resolution changes which lines hold a draft back, so like publish.ts it stays out
// of any client import graph.
import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { normaliseTerm } from "@/lib/domain/resolve-exclusions";
import { aliasStanding, linesMatchingAlias } from "@/lib/domain/reresolve";

import type { Tx } from "./drafts";
import { canonicalIngredient, ingredientAlias, recipe, recipeIngredient } from "./schema";
import { loadResolutionTerms } from "./terms";

/**
 * The alias fix: a human says what a term means, and every draft line held by exactly
 * that term resolves through the same index gate 1 uses — in the alias's transaction, so
 * an alias never lands without the lines it unblocks, or the reverse. No model is asked
 * what an ingredient is.
 *
 * It clears a blocker and nothing more. No recipe changes status here; a human still
 * presses publish, and the publish gate still checks every line (§2).
 */

export type AddAliasResult =
  | { kind: "added"; reresolved: number }
  | { kind: "already_known"; reresolved: number }
  | { kind: "alias_exists" }
  | { kind: "unknown_ingredient" }
  | { kind: "no_unresolved_line" };

export async function addAliasAndReresolve(
  tx: Tx,
  input: { alias: string; canonicalId: string },
): Promise<AddAliasResult> {
  const [target] = await tx
    .select({ id: canonicalIngredient.id })
    .from(canonicalIngredient)
    .where(eq(canonicalIngredient.id, input.canonicalId));
  if (!target) return { kind: "unknown_ingredient" };

  const standing = aliasStanding(input.alias, target.id, await loadResolutionTerms(tx));
  if (standing === "conflict") return { kind: "alias_exists" };

  if (standing === "new") {
    // Stored normalised, so the raw-text unique index and the normalised index agree on
    // what a duplicate is. DO NOTHING rather than a caught 23505: a concurrent insert of
    // the same alias loses cleanly, without aborting the transaction it is part of.
    const [inserted] = await tx
      .insert(ingredientAlias)
      .values({ alias: normaliseTerm(input.alias), canonicalId: target.id, source: "extraction" })
      .onConflictDoNothing({ target: ingredientAlias.alias })
      .returning({ id: ingredientAlias.id });
    if (!inserted) return { kind: "alias_exists" };
  }
  const kind = standing === "new" ? "added" : "already_known";

  // Drafts only. A published recipe can't hold a null line, so this excludes nothing
  // today; it means the fix could never rewrite a row gate 2 is already returning.
  const unresolved = await tx
    .select({ id: recipeIngredient.id, name: recipeIngredient.name })
    .from(recipeIngredient)
    .innerJoin(recipe, eq(recipe.id, recipeIngredient.recipeId))
    .where(and(isNull(recipeIngredient.canonicalId), eq(recipe.status, "draft")));

  // Matched in TypeScript with the index's own normalisation, not re-implemented in SQL,
  // so gate 1 has one definition of "the same term".
  const ids = linesMatchingAlias(unresolved, input.alias);
  if (ids.length === 0) return { kind, reresolved: 0 };

  const updated = await tx
    .update(recipeIngredient)
    .set({ canonicalId: target.id })
    .where(and(inArray(recipeIngredient.id, ids), isNull(recipeIngredient.canonicalId)))
    .returning({ id: recipeIngredient.id });
  return { kind, reresolved: updated.length };
}
