import { normaliseTerm } from "./resolve-exclusions";

/**
 * Deterministic ingredient resolution: a term matches a canonical name or alias exactly,
 * after the same normalisation gate 1 uses, or it is unresolved. No fuzzy matching — a near
 * miss belongs in review, because a guessed match is how an allergen gets filed under
 * the wrong node.
 */

export function buildNameIndex(entries: readonly { term: string; id: string }[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const { term, id } of entries) {
    const key = normaliseTerm(term);
    const existing = index.get(key);
    // An ambiguous term has no safe answer, so refuse to build rather than pick one.
    if (existing !== undefined && existing !== id) {
      throw new Error(`"${key}" resolves to two different ingredients`);
    }
    index.set(key, id);
  }
  return index;
}

export function resolveTerm(term: string, index: ReadonlyMap<string, string>): string | null {
  return index.get(normaliseTerm(term)) ?? null;
}

/**
 * Published only if every ingredient resolved, optional ones included: an optional
 * ingredient nobody can identify can still carry an allergen.
 */
export function deriveRecipeStatus(
  ingredients: readonly { canonicalId: string | null; optional: boolean }[],
): "draft" | "published" {
  if (ingredients.length === 0) return "draft";
  return ingredients.every((i) => i.canonicalId !== null) ? "published" : "draft";
}
