import { normaliseTerm } from "@/lib/domain/resolve-exclusions";

/**
 * Pure scorers for term lists. Terms are compared the way gate 1 compares them —
 * through `normaliseTerm` — so a match here is a match the resolver would also see.
 */

/** One expected ingredient: a single spelling, or several spellings of the same ingredient. */
export type ExpectedTerm = string | readonly string[];

export interface MatchCounts {
  tp: number;
  fp: number;
  fn: number;
}

/**
 * Each expected term claims at most one distinct actual term, and each actual term fills
 * at most one expected slot. Greedy is enough because a fixture never lists one spelling
 * under two slots (`evals/fixtures.test.ts`).
 */
export function matchTerms(expected: readonly ExpectedTerm[], actual: readonly string[]): MatchCounts {
  const unused = new Set(actual.map(normaliseTerm));
  let tp = 0;
  for (const term of expected) {
    const spellings = (typeof term === "string" ? [term] : term).map(normaliseTerm);
    const hit = spellings.find((s) => unused.has(s));
    if (hit !== undefined) {
      unused.delete(hit);
      tp++;
    }
  }
  return { tp, fp: unused.size, fn: expected.length - tp };
}

export function setExactMatch(expected: readonly ExpectedTerm[], actual: readonly string[]): boolean {
  const { fp, fn } = matchTerms(expected, actual);
  return fp === 0 && fn === 0;
}

/** Counts are summed before computing F1. Nothing expected and nothing returned is a perfect 1. */
export function microF1(counts: readonly MatchCounts[]): number {
  const tp = counts.reduce((n, c) => n + c.tp, 0);
  const errors = counts.reduce((n, c) => n + c.fp + c.fn, 0);
  return tp + errors === 0 ? 1 : (2 * tp) / (2 * tp + errors);
}
