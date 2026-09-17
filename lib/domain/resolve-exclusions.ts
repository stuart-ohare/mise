import type { ExclusionResolution } from "./constraints";

/**
 * Gate 1. Maps each `exclude` term to a canonical ingredient id or returns it as
 * unresolved, so the user is asked about it. No term is ever dropped.
 *
 * Matching is exact after normalisation: no fuzzy matching, stemming or substring
 * matching. A miss is a question to the user; a wrong fuzzy hit is a silent
 * allergen leak.
 */

/** Normalised term → canonical id. Build it with `buildResolutionIndex`. */
export type ResolutionIndex = ReadonlyMap<string, string>;

/**
 * NFC first, so accented names match however the input was encoded. `\s` also
 * catches the non-breaking spaces that come with text pasted from recipe sites.
 */
export function normaliseTerm(term: string): string {
  return term.normalize("NFC").toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Builds the index from canonical names and aliases, normalising the keys here so a
 * caller can't build keys that `resolveExclusions` never matches.
 *
 * A term claimed by two different ids is left out, so it resolves to neither and the
 * user is asked. Picking one would silently exclude the wrong ingredient.
 */
export function buildResolutionIndex(
  entries: readonly { term: string; canonicalId: string }[],
): ResolutionIndex {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { term, canonicalId } of entries) {
    const key = normaliseTerm(term);
    const existing = index.get(key);
    if (existing !== undefined && existing !== canonicalId) ambiguous.add(key);
    index.set(key, canonicalId);
  }
  for (const key of ambiguous) index.delete(key);
  return index;
}

/**
 * One result per distinct normalised term, in input order. `term` is the first
 * occurrence as the user typed it, so the question they're asked shows their words.
 */
export function resolveExclusions(
  terms: readonly string[],
  index: ResolutionIndex,
): ExclusionResolution[] {
  const seen = new Set<string>();
  const results: ExclusionResolution[] = [];
  for (const term of terms) {
    const key = normaliseTerm(term);
    if (seen.has(key)) continue;
    seen.add(key);
    const canonicalId = index.get(key);
    results.push(
      canonicalId === undefined
        ? { kind: "unresolved", term }
        : { kind: "resolved", term, canonicalId },
    );
  }
  return results;
}
