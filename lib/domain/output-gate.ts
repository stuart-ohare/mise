import type { IngredientNode } from "./ingredient-tree";

export type ScanHit = { term: string; index: number; match: string };

export type ViolationRecord = {
  attempt: 1 | 2;
  matchedTerms: string[];
  generated: string;
  retrySucceeded: boolean;
};

export type OutputGateResult<T> =
  | { kind: "prose"; output: T; attempts: 1 | 2 }
  | { kind: "downgraded"; violations: { attempt: 1 | 2; matchedTerms: string[] }[] };

export function outputTerms(
  nodes: readonly IngredientNode[],
  aliases: readonly { canonicalId: string; alias: string }[],
  excludedIds: readonly string[],
): string[] {
  void nodes;
  void aliases;
  void excludedIds;
  return [];
}

export function scanProse(text: string, terms: readonly string[]): ScanHit[] {
  void text;
  void terms;
  return [];
}

export function collectStrings(value: unknown): string[] {
  void value;
  return [];
}

export async function runOutputGate<T>(opts: {
  generate: (violatedTerms?: readonly string[]) => Promise<T>;
  scan: (output: T) => ScanHit[];
  onViolation: (record: ViolationRecord) => void | Promise<void>;
}): Promise<OutputGateResult<T>> {
  void opts;
  return { kind: "downgraded", violations: [] };
}
