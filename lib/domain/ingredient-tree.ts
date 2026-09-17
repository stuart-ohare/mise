/**
 * The canonical ingredient tree, as pure functions over an in-memory node list.
 *
 * Gate 2 does this walk in SQL. These mirror it so the rule — an exclusion covers
 * a node and every descendant, and a tag on an ancestor applies to every
 * descendant — is pinned by unit tests that need no database.
 */

export type IngredientNode = {
  id: string;
  name: string;
  parentId: string | null;
  allergenTags: string[];
};

/**
 * The ids of a node and every descendant. Excluding "dairy" must exclude ghee,
 * which is only reachable by walking down through butter.
 */
export function subtreeIds(nodes: readonly IngredientNode[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId) ?? [];
    siblings.push(node.id);
    childrenOf.set(node.parentId, siblings);
  }

  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    // The seen check also guards against a cycle in bad seed data.
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }
  return seen;
}

/**
 * The allergen tags carried by a node or inherited from any ancestor.
 */
export function effectiveAllergenTags(
  nodes: readonly IngredientNode[],
  id: string,
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const tags = new Set<string>();
  const visited = new Set<string>();

  let current = byId.get(id);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    for (const tag of current.allergenTags) tags.add(tag);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return tags;
}

/**
 * The ids a single exclusion removes — what gate 2's SQL must match.
 *
 * The tree is single-parent, so an ingredient with two allergens sits under one
 * root and carries the other as its own tag: soy sauce is under soy, tagged gluten.
 * Excluding an allergen root therefore removes its subtree *and* the subtree of
 * every node tagged with that allergen. Excluding any other node removes only its
 * subtree — excluding soy sauce must not exclude all gluten.
 */
export function exclusionIds(nodes: readonly IngredientNode[], excludedId: string): Set<string> {
  const ids = subtreeIds(nodes, excludedId);
  const excluded = nodes.find((node) => node.id === excludedId);
  if (!excluded || excluded.parentId !== null) return ids;

  for (const node of nodes) {
    if (!node.allergenTags.some((tag) => excluded.allergenTags.includes(tag))) continue;
    for (const id of subtreeIds(nodes, node.id)) ids.add(id);
  }
  return ids;
}
