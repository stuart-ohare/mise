import { exclusionIds, type IngredientNode } from "./ingredient-tree";
import { normaliseTerm } from "./resolve-exclusions";

/**
 * Gate 3. Gate 2 guarantees the rows; nothing guarantees the sentences written about
 * them except scanning those sentences before they render. Everything here fails
 * closed: a false positive costs some prose, a false negative costs an allergen.
 */

/** `index` is into the NFC, lower-cased text; `match` saves rebuilding offsets. */
export type ScanHit = { term: string; index: number; match: string };

/** Mirrors `output_violation`. `generated` is the parsed output as JSON. */
export type ViolationRecord = {
  attempt: 1 | 2;
  matchedTerms: string[];
  generated: string;
  retrySucceeded: boolean;
};

/**
 * A gate failure is a value. The downgraded variant carries no generated text, so
 * rejected prose can't reach a response by accident; only the sink sees it.
 */
export type OutputGateResult<T> =
  | { kind: "prose"; output: T; attempts: 1 | 2 }
  | { kind: "downgraded"; violations: { attempt: 1 | 2; matchedTerms: string[] }[] };

/**
 * The names and aliases of every id gate 2 excludes, so the prose is held to the same
 * widened set as the rows: ancestors and cross-tree tagged nodes included.
 */
export function outputTerms(
  nodes: readonly IngredientNode[],
  aliases: readonly { canonicalId: string; alias: string }[],
  excludedIds: readonly string[],
): string[] {
  const ids = new Set(excludedIds.flatMap((id) => [...exclusionIds(nodes, id)]));
  const raw = [
    ...nodes.filter((node) => ids.has(node.id)).map((node) => node.name),
    ...aliases.filter((entry) => ids.has(entry.canonicalId)).map((entry) => entry.alias),
  ];
  const terms = new Set(raw.map(normaliseTerm).filter((term) => term.length > 0));
  return [...terms].sort();
}

// Syntax characters only: under the `u` flag, escaping anything else is an error.
const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/**
 * Word-start prefix match: "butter" hits "buttery" and "butternut" but not
 * "unbuttered". Only the last word of a multi-word term is prefix-matched, and words
 * may be separated by any whitespace or hyphens. Negation is deliberately not parsed:
 * "dairy-free" is a hit, because prose must not name an excluded ingredient at all.
 */
export function scanProse(text: string, terms: readonly string[]): ScanHit[] {
  const haystack = text.normalize("NFC").toLowerCase();
  const hits: ScanHit[] = [];
  for (const term of new Set(terms.map(normaliseTerm))) {
    if (term.length === 0) continue;
    const words = term.split(" ").map(escapeRegex).join("[\\s-]+");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${words}\\p{L}*`, "giu");
    for (const found of haystack.matchAll(pattern)) {
      hits.push({ term, index: found.index, match: found[0] });
    }
  }
  return hits.sort((a, b) => a.index - b.index || (a.term < b.term ? -1 : 1));
}

/** Every string in a parsed output, depth-first, so no field escapes the scan. */
export function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

const distinctTerms = (hits: readonly ScanHit[]) => [...new Set(hits.map((hit) => hit.term))];

/**
 * Scan, retry once with the violated terms named, then downgrade to cards without
 * prose. A `generate` that throws isn't a gate event and propagates.
 */
export async function runOutputGate<T>(opts: {
  generate: (violatedTerms?: readonly string[]) => Promise<T>;
  scan: (output: T) => ScanHit[];
  onViolation: (record: ViolationRecord) => void | Promise<void>;
}): Promise<OutputGateResult<T>> {
  const { generate, scan, onViolation } = opts;

  const first = await generate();
  const firstTerms = distinctTerms(scan(first));
  if (firstTerms.length === 0) return { kind: "prose", output: first, attempts: 1 };

  // Attempt 1's record needs the retry's outcome, so it's emitted once that's known —
  // in a finally, so a rejected generation is still recorded if the retry throws.
  let retry: { output: T; terms: string[] } | undefined;
  try {
    const output = await generate(firstTerms);
    retry = { output, terms: distinctTerms(scan(output)) };
  } finally {
    await onViolation({
      attempt: 1,
      matchedTerms: firstTerms,
      generated: JSON.stringify(first),
      retrySucceeded: retry !== undefined && retry.terms.length === 0,
    });
  }

  if (retry.terms.length === 0) return { kind: "prose", output: retry.output, attempts: 2 };

  await onViolation({
    attempt: 2,
    matchedTerms: retry.terms,
    generated: JSON.stringify(retry.output),
    retrySucceeded: false,
  });
  return {
    kind: "downgraded",
    violations: [
      { attempt: 1, matchedTerms: firstTerms },
      { attempt: 2, matchedTerms: retry.terms },
    ],
  };
}
