import type { ExclusionResolution } from "./constraints";

export type ResolutionIndex = ReadonlyMap<string, string>;

export function normaliseTerm(term: string): string {
  return term;
}

export function buildResolutionIndex(
  _entries: readonly { term: string; canonicalId: string }[],
): ResolutionIndex {
  return new Map();
}

export function resolveExclusions(
  _terms: readonly string[],
  _index: ResolutionIndex,
): ExclusionResolution[] {
  return [];
}
