import { exclusionIds, type IngredientNode } from "./ingredient-tree";
import { normaliseTerm } from "./resolve-exclusions";

/**
 * Gate 3. Gate 2 guarantees the rows; nothing guarantees the sentences written about
 * them except scanning those sentences before they render. Everything here fails
 * closed: a false positive costs some prose, a false negative costs an allergen.
 */

/**
 * `index` and `match` are both in the caller's own string: `match` is exactly
 * `text.slice(index, index + match.length)`, so a logged violation quotes the prose as
 * it was written rather than a folded approximation of it.
 */
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
 *
 * Throws when an exclusion contributes no term — an id missing from `nodes`, or one
 * whose names all normalise to nothing. Gate 2 fails closed on a bad id, since the row
 * stays excluded, so gate 3 must not answer the same mistake with an empty term set,
 * which would scan for nothing and pass everything. An empty result therefore only
 * ever means nothing was excluded.
 */
export function outputTerms(
  nodes: readonly IngredientNode[],
  aliases: readonly { canonicalId: string; alias: string }[],
  excludedIds: readonly string[],
): string[] {
  const terms = new Set<string>();
  const empty: string[] = [];

  for (const excludedId of excludedIds) {
    const ids = exclusionIds(nodes, excludedId);
    const raw = [
      ...nodes.filter((node) => ids.has(node.id)).map((node) => node.name),
      ...aliases.filter((entry) => ids.has(entry.canonicalId)).map((entry) => entry.alias),
    ];
    const found = raw.map(normaliseTerm).filter((term) => term.length > 0);
    if (found.length === 0) empty.push(excludedId);
    for (const term of found) terms.add(term);
  }

  if (empty.length > 0) {
    const ids = [...new Set(empty)].sort().join(", ");
    throw new Error(`Excluded ingredient contributed no term to scan for: ${ids}`);
  }
  return [...terms].sort();
}

// Syntax characters only: under the `u` flag, escaping anything else is an error.
const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** Typographic dashes: prose gets them from anywhere text is pasted or auto-formatted. */
const DASHES = /[\u2010-\u2015\u2212]/g;

/** The folded text, and where each of its code units started in the original. */
type Folded = { text: string; offsets: number[] };

/**
 * Case, accents and dash variants folded away, on the prose and on the terms alike, so
 * that folding can only merge spellings and never separate them. Gate 1 deliberately
 * does none of this — there a miss is a question to the user, so fuzz buys nothing and
 * risks resolving the wrong ingredient silently. Here a miss is an allergen in a sentence.
 *
 * Folded one code point at a time so `offsets` stays truthful: both lower-casing and
 * dropping a combining mark change length, and an offset is worth nothing if it points
 * into a string the caller never saw.
 */
function fold(text: string): Folded {
  let folded = "";
  const offsets: number[] = [];
  let start = 0;
  for (const char of text) {
    const mapped = char.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(DASHES, "-");
    for (let i = 0; i < mapped.length; i += 1) offsets.push(start);
    folded += mapped;
    start += char.length;
  }
  offsets.push(text.length);
  return { text: folded, offsets };
}

/**
 * The pattern prefix-matches a term's last word, so trimming one letter off that word
 * widens it: "cheese" then reaches "cheesy", "oats" reaches "oat" and "oatmeal".
 *
 * The length floors are the entire safety margin, and are set against the real
 * catalogue rather than in the abstract: "whey" trimmed to "whe" would hit "when",
 * "wheat" and "whether", and a gate that rejects "when" is a gate someone turns off.
 * For the same reason there is no rule for a final "y". The cost of what is left is
 * "oat" hitting "oath", which is the direction this gate is allowed to be wrong in.
 */
function stem(word: string): string {
  if (word.length >= 5 && word.endsWith("e")) return word.slice(0, -1);
  if (word.length >= 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * Word-start prefix match on a folded, stemmed term: "butter" hits "buttery" and
 * "butternut" but not "unbuttered". Only the last word of a multi-word term is
 * prefix-matched and stemmed. Whitespace and dashes are interchangeable in both
 * directions, because prose and the catalogue disagree about them: the alias
 * "self-raising flour" must hit "self raising flour". Negation is deliberately not
 * parsed: "dairy-free" is a hit, because prose must not name an excluded ingredient
 * at all.
 */
export function scanProse(text: string, terms: readonly string[]): ScanHit[] {
  const haystack = fold(text);
  const hits: ScanHit[] = [];
  for (const term of new Set(terms.map(normaliseTerm))) {
    const words = fold(term).text.split(/[\s-]+/).filter((word) => word.length > 0);
    const last = words.pop();
    // A term that folds to nothing scannable is a bad catalogue row, not a clean scan.
    // Skipping it would let every sentence past for that exclusion, so it fails loudly:
    // the caller sees an error and no prose, which is the direction this gate errs in.
    if (last === undefined) throw new Error(`Term has nothing to scan for: ${JSON.stringify(term)}`);
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${[...words, stem(last)].map(escapeRegex).join("[\\s-]+")}\\p{L}*`,
      "giu",
    );
    for (const found of haystack.text.matchAll(pattern)) {
      // Every code unit of the folded text has an offset, and one past its end, so both
      // ends resolve. No fallback: a folded offset substituted into the caller's
      // coordinates would be a plausible wrong answer, which is worse than a crash.
      const start = haystack.offsets[found.index];
      const end = haystack.offsets[found.index + found[0].length];
      hits.push({ term, index: start, match: text.slice(start, end) });
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
