export type ExpectedTerm = string | readonly string[];

export interface MatchCounts {
  tp: number;
  fp: number;
  fn: number;
}

export function matchTerms(expected: readonly ExpectedTerm[], actual: readonly string[]): MatchCounts {
  void expected;
  void actual;
  throw new Error("not implemented");
}

export function setExactMatch(expected: readonly ExpectedTerm[], actual: readonly string[]): boolean {
  void expected;
  void actual;
  throw new Error("not implemented");
}

export function microF1(counts: readonly MatchCounts[]): number {
  void counts;
  throw new Error("not implemented");
}
