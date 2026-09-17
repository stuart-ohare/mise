import { z } from "zod";

/**
 * The hand-authored top of the canonical ingredient tree, as it is committed in
 * `scripts/seed/taxonomy.json`. Gate 2 walks this tree, so the file is parsed and
 * then validated as a whole before a single row is written.
 */

export const ALLERGENS = ["dairy", "gluten", "nuts", "shellfish", "egg", "soy"] as const;

// Gate 1 matches terms exactly and the database's unique indexes are case-sensitive,
// so the file itself must already be normalised rather than relying on either.
export const term = z
  .string()
  .min(1)
  .refine((s) => s === s.trim().toLowerCase(), "must be lowercase with no surrounding spaces");

export const taxonomyNodeSchema = z.object({
  name: term,
  parent: term.nullable(),
  allergenTags: z.array(z.enum(ALLERGENS)),
  aliases: z.array(term),
});

export const taxonomySchema = z.object({
  nodes: z.array(taxonomyNodeSchema),
});

export type Taxonomy = z.infer<typeof taxonomySchema>;
export type TaxonomyNode = Taxonomy["nodes"][number];

export type TaxonomyValidation =
  | { ok: true; nodes: TaxonomyNode[] }
  | { ok: false; errors: string[] };

const normalise = (s: string) => s.trim().toLowerCase();

/**
 * Checks the tree as a whole: every parent exists, there are no cycles, and names
 * and aliases share one case-insensitive namespace — gate 1 resolves against both,
 * so a term claimed twice would mean two ingredients. Returns every error at once,
 * or the nodes ordered parent-first so they can be inserted in that order.
 */
export function validateTaxonomy(taxonomy: Taxonomy): TaxonomyValidation {
  const errors: string[] = [];
  const byName = new Map<string, TaxonomyNode>();
  const owner = new Map<string, string>();

  for (const node of taxonomy.nodes) {
    const name = normalise(node.name);
    if (byName.has(name)) {
      errors.push(`duplicate name "${name}"`);
      continue;
    }
    byName.set(name, node);
    owner.set(name, name);

    // exclusionIds widens an allergen root's exclusion by that root's own tag, so an
    // allergen root must carry exactly its tag and no other root may carry one.
    if (node.parent === null) {
      const expected = ALLERGENS.filter((allergen) => allergen === name);
      const tags = [...node.allergenTags].sort();
      if (tags.length !== expected.length || tags.some((tag, i) => tag !== expected[i])) {
        errors.push(`root "${name}" must have allergenTags [${expected.join(", ")}]`);
      }
    }
  }

  for (const node of byName.values()) {
    const name = normalise(node.name);
    for (const alias of node.aliases.map(normalise)) {
      const claimant = owner.get(alias);
      if (claimant === undefined) {
        owner.set(alias, name);
      } else if (claimant === alias) {
        errors.push(`alias "${alias}" of "${name}" is already the name of a node`);
      } else {
        errors.push(`alias "${alias}" is claimed by both "${claimant}" and "${name}"`);
      }
    }
  }

  const cyclic = new Set<string>();
  for (const [name, node] of byName) {
    if (node.parent === null) continue;
    const parent = normalise(node.parent);
    if (!byName.has(parent)) {
      errors.push(`"${name}" has parent "${parent}", which doesn't exist`);
      continue;
    }

    const chain = new Set([name]);
    let current = parent;
    while (true) {
      if (chain.has(current)) {
        cyclic.add(name);
        break;
      }
      chain.add(current);
      const next = byName.get(current)?.parent;
      // A root ends the walk; a missing parent is reported on its own node.
      if (next === null || next === undefined || !byName.has(normalise(next))) break;
      current = normalise(next);
    }
  }
  if (cyclic.size > 0) {
    errors.push(`cycle through ${[...cyclic].sort().join(", ")}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const ordered: TaxonomyNode[] = [];
  const placed = new Set<string>();
  let frontier = [...byName.values()].filter((n) => n.parent === null);
  while (frontier.length > 0) {
    ordered.push(...frontier);
    for (const n of frontier) placed.add(normalise(n.name));
    frontier = [...byName.values()].filter(
      (n) => n.parent !== null && placed.has(normalise(n.parent)) && !placed.has(normalise(n.name)),
    );
  }
  return { ok: true, nodes: ordered };
}
