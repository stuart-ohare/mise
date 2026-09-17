import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import type { z } from "zod";

import { recipesSchema, leavesSchema, type Recipe } from "@/lib/ai/prompts/seed-catalogue";
import type { Db } from "@/lib/db/client";
import {
  canonicalIngredient,
  ingredientAlias,
  recipe,
  recipeIngredient,
  recipeStep,
} from "@/lib/db/schema";
import { buildNameIndex, deriveRecipeStatus, resolveTerm } from "@/lib/domain/resolution";
import { taxonomySchema, validateTaxonomy, type TaxonomyNode } from "@/lib/domain/taxonomy";
import { claimsFromNodes, findTermCollisions, type TermCollision } from "@/lib/domain/term-namespace";

/**
 * The body of `pnpm seed`, apart from the connection, so the database tests can run it
 * inside a transaction that rolls back. `load.ts` is the command-line wrapper.
 */

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The committed files, parsed and validated: nodes are parent-first. */
export type SeedFiles = { nodes: TaxonomyNode[]; recipes: Recipe[] };

export type SeedCounts = { draft: number; published: number; skipped: number };

export type SeedResult = { ok: true; counts: SeedCounts } | { ok: false; collisions: TermCollision[] };

function readJson<T>(file: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; errors: string[] } {
  const parsed = schema.safeParse(JSON.parse(readFileSync(resolve(__dirname, file), "utf8")));
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    errors: [
      `${file} doesn't match its schema:`,
      ...parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`),
    ],
  };
}

export function readSeedFiles(): { ok: true; files: SeedFiles } | { ok: false; errors: string[] } {
  const taxonomy = readJson("taxonomy.json", taxonomySchema);
  const leaves = readJson("leaves.json", leavesSchema);
  const catalogue = readJson("recipes.json", recipesSchema);
  if (!taxonomy.ok || !leaves.ok || !catalogue.ok) {
    return {
      ok: false,
      errors: [taxonomy, leaves, catalogue].flatMap((r) => (r.ok ? [] : r.errors)),
    };
  }

  // Generated leaves are validated with the hand-authored tree, not beside it, so a
  // leaf can't take a hand-authored name or hang under a node that doesn't exist.
  const validation = validateTaxonomy({ nodes: [...taxonomy.data.nodes, ...leaves.data.nodes] });
  if (!validation.ok) {
    return {
      ok: false,
      errors: [
        "taxonomy.json and leaves.json don't form a valid tree:",
        ...validation.errors.map((error) => `  ${error}`),
      ],
    };
  }
  return { ok: true, files: { nodes: validation.nodes, recipes: catalogue.data.recipes } };
}

/**
 * Safe to run repeatedly: nodes upsert by name, aliases by alias, and a recipe whose
 * title already exists is skipped, so a second run changes nothing — and never undoes a
 * draft someone has since promoted in review.
 *
 * Before anything is written, every name and alias in the database and the files must
 * belong to one ingredient. Otherwise it writes nothing and returns the collisions.
 */
export async function seedDatabase(tx: Tx, files: SeedFiles): Promise<SeedResult> {
  // Checked against the database, not just the files: review can add names and aliases
  // the files don't know about, and an alias moved onto another ingredient is exactly how
  // an allergen would move.
  const existingNames = await tx
    .select({ term: canonicalIngredient.name, ingredient: canonicalIngredient.name })
    .from(canonicalIngredient);
  const existingAliases = await tx
    .select({ term: ingredientAlias.alias, ingredient: canonicalIngredient.name })
    .from(ingredientAlias)
    .innerJoin(canonicalIngredient, eq(ingredientAlias.canonicalId, canonicalIngredient.id));
  const collisions = findTermCollisions([
    ...existingNames,
    ...existingAliases,
    ...claimsFromNodes(files.nodes),
  ]);
  if (collisions.length > 0) return { ok: false, collisions };

  const counts: SeedCounts = { draft: 0, published: 0, skipped: 0 };

  const ids = new Map<string, string>();
  for (const node of files.nodes) {
    const parentId = node.parent === null ? null : ids.get(node.parent);
    if (parentId === undefined) throw new Error(`"${node.name}" was ordered before its parent`);

    const [row] = await tx
      .insert(canonicalIngredient)
      .values({ name: node.name, parentId, allergenTags: node.allergenTags })
      .onConflictDoUpdate({
        target: canonicalIngredient.name,
        set: { parentId, allergenTags: node.allergenTags },
      })
      .returning({ id: canonicalIngredient.id });
    if (!row) throw new Error(`upsert of "${node.name}" returned no row`);
    ids.set(node.name, row.id);
  }

  const wanted = new Map<string, string>();
  for (const node of files.nodes) {
    const canonicalId = ids.get(node.name);
    if (canonicalId === undefined) throw new Error(`"${node.name}" has no id`);
    for (const alias of node.aliases) wanted.set(alias, canonicalId);
  }
  if (wanted.size > 0) {
    // Doing nothing on conflict is safe only because of the check above: an existing
    // alias already points at the ingredient the files give it.
    await tx
      .insert(ingredientAlias)
      .values([...wanted].map(([alias, canonicalId]) => ({ alias, canonicalId, source: "hand" })))
      .onConflictDoNothing({ target: ingredientAlias.alias });
  }

  // Resolve against the database, not the files: it also holds aliases added in review.
  // buildNameIndex still throws on an ambiguous term, as a second line of defence.
  const names = await tx
    .select({ term: canonicalIngredient.name, id: canonicalIngredient.id })
    .from(canonicalIngredient);
  const aliases = await tx
    .select({ term: ingredientAlias.alias, id: ingredientAlias.canonicalId })
    .from(ingredientAlias);
  const index = buildNameIndex([...names, ...aliases]);

  const titles = new Set(
    (await tx.select({ title: recipe.title }).from(recipe)).map((r) => r.title.toLowerCase()),
  );
  for (const entry of files.recipes) {
    if (titles.has(entry.title.toLowerCase())) {
      counts.skipped++;
      continue;
    }
    const ingredients = entry.ingredients.map((i) => ({
      canonicalId: resolveTerm(i.name, index),
      rawText: i.rawText,
      qty: i.qty === null ? null : String(i.qty),
      unit: i.unit,
      optional: i.optional,
    }));
    const status = deriveRecipeStatus(ingredients);
    counts[status]++;

    const [row] = await tx
      .insert(recipe)
      .values({
        title: entry.title,
        summary: entry.summary,
        minutes: entry.minutes,
        serves: entry.serves,
        status,
      })
      .returning({ id: recipe.id });
    if (!row) throw new Error(`insert of "${entry.title}" returned no row`);
    await tx.insert(recipeIngredient).values(ingredients.map((i) => ({ ...i, recipeId: row.id })));
    await tx
      .insert(recipeStep)
      .values(entry.steps.map((text, position) => ({ recipeId: row.id, position: position + 1, text })));
  }

  return { ok: true, counts };
}
