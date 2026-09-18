import { normaliseTerm } from "./resolve-exclusions";

/**
 * Gate 1's repair path. When a human names what a term means, the lines it unblocks are
 * the ones whose `name` is that term after the normalisation the index uses — exact, as
 * resolution is everywhere else. Never a substring of `raw_text`: "ghee butter" is not
 * ghee, and reading a food out of prose is the guess this architecture exists to avoid.
 */

export function linesMatchingAlias(
  lines: readonly { id: string; name: string }[],
  alias: string,
): string[] {
  const key = normaliseTerm(alias);
  return lines.filter((line) => normaliseTerm(line.name) === key).map((line) => line.id);
}

/**
 * Whether a term already means something, as a canonical name or as an alias. Compared
 * after normalisation because the unique index on `ingredient_alias.alias` compares raw
 * text: `Ghee` beside `ghee` would insert, and then the seed's `buildNameIndex` throws
 * while Cook's `buildResolutionIndex` quietly stops resolving either.
 */
export function aliasConflict(alias: string, terms: readonly { term: string }[]): boolean {
  const key = normaliseTerm(alias);
  return terms.some((t) => normaliseTerm(t.term) === key);
}
