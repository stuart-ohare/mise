export function linesMatchingAlias(
  _lines: readonly { id: string; name: string }[],
  _alias: string,
): string[] {
  return [];
}

export function aliasConflict(_alias: string, _terms: readonly { term: string }[]): boolean {
  return false;
}
