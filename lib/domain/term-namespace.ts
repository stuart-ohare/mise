import { normaliseTerm } from "./resolve-exclusions";
import type { TaxonomyNode } from "./taxonomy";

/**
 * Names and aliases share one namespace, because gate 1 resolves a term against both.
 * A term claimed by two ingredients has no safe answer, so any write path that adds a
 * name or alias checks every existing claim, not just its own, before writing.
 */

/** `ingredient` is the canonical name exactly as stored: the unique index is case-sensitive. */
export type TermClaim = { term: string; ingredient: string };
export type TermCollision = { term: string; ingredients: string[] };

/** Normalised as gate 1 normalises, so anything gate 1 would find ambiguous is reported. */
export function findTermCollisions(claims: readonly TermClaim[]): TermCollision[] {
  const claimants = new Map<string, Set<string>>();
  for (const { term, ingredient } of claims) {
    const key = normaliseTerm(term);
    const set = claimants.get(key) ?? new Set<string>();
    set.add(ingredient);
    claimants.set(key, set);
  }
  return [...claimants]
    .filter(([, ingredients]) => ingredients.size > 1)
    .map(([term, ingredients]) => ({ term, ingredients: [...ingredients].sort() }))
    .sort((a, b) => a.term.localeCompare(b.term));
}

/** Each node claims its own name and each of its aliases. */
export function claimsFromNodes(nodes: readonly Pick<TaxonomyNode, "name" | "aliases">[]): TermClaim[] {
  return nodes.flatMap((node) =>
    [node.name, ...node.aliases].map((term) => ({ term, ingredient: node.name })),
  );
}
