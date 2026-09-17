/**
 * Gate 2 walks the ingredient tree, so a node's parent and tags decide which exclusions
 * reach every recipe under it. Any write path that overwrites them reports what would
 * move first, so a person sees the change before it widens or narrows an exclusion.
 */

/** `parent` is the parent's name, or null for a root. Nodes match by exact stored name. */
export type TreeNode = { name: string; parent: string | null; allergenTags: readonly string[] };
export type TreeChange = {
  name: string;
  parent?: { from: string | null; to: string | null };
  tags?: { from: string[]; to: string[] };
};

const tagSet = (tags: readonly string[]) => [...new Set(tags)].sort();

/** Nodes only on one side aren't changes: a new node is an insert, and a node missing from the files is left alone. */
export function findTreeChanges(existing: readonly TreeNode[], files: readonly TreeNode[]): TreeChange[] {
  const byName = new Map(existing.map((node) => [node.name, node]));
  const changes: TreeChange[] = [];
  for (const node of files) {
    const current = byName.get(node.name);
    if (!current) continue;

    const change: TreeChange = { name: node.name };
    if (current.parent !== node.parent) change.parent = { from: current.parent, to: node.parent };
    const from = tagSet(current.allergenTags);
    const to = tagSet(node.allergenTags);
    if (from.join("\n") !== to.join("\n")) change.tags = { from, to };
    if (change.parent || change.tags) changes.push(change);
  }
  return changes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
