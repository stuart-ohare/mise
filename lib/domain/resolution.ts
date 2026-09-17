export function buildNameIndex(entries: readonly { term: string; id: string }[]): Map<string, string> {
  void entries;
  return new Map();
}

export function resolveTerm(term: string, index: ReadonlyMap<string, string>): string | null {
  void term;
  void index;
  return null;
}

export function deriveRecipeStatus(
  ingredients: readonly { canonicalId: string | null; optional: boolean }[],
): "draft" | "published" {
  void ingredients;
  return "draft";
}
