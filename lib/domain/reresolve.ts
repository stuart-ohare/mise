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
 * What a term already means, before it is written as an alias. Compared after
 * normalisation because the unique index on `ingredient_alias.alias` compares raw text:
 * `Ghee` beside `ghee` would insert, and then the seed's `buildNameIndex` throws while
 * Cook's `buildResolutionIndex` quietly stops resolving either.
 *
 * - `new` — nothing claims it; write the alias.
 * - `known` — it already means this ingredient and nothing else. Nothing to write, but a
 *   line can still be null under it (Intake built its index before the alias landed, or
 *   a re-seed added it), and re-resolving is the only way that draft unblocks.
 * - `conflict` — it means something else, or is already ambiguous. Refused.
 */
export function aliasStanding(
  alias: string,
  canonicalId: string,
  terms: readonly { term: string; canonicalId: string }[],
): "new" | "known" | "conflict" {
  const key = normaliseTerm(alias);
  const owners = new Set(terms.filter((t) => normaliseTerm(t.term) === key).map((t) => t.canonicalId));
  if (owners.size === 0) return "new";
  return owners.size === 1 && owners.has(canonicalId) ? "known" : "conflict";
}
