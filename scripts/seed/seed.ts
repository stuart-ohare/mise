import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { inArray } from "drizzle-orm";
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

/**
 * The body of `pnpm seed`, apart from the connection, so the database tests can run it
 * inside a transaction that rolls back. `load.ts` is the command-line wrapper.
 */

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The committed files, parsed and validated: nodes are parent-first. */
export type SeedFiles = { nodes: TaxonomyNode[]; recipes: Recipe[] };

export type SeedCounts = { draft: number; published: number; skipped: number };

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
 */
export async function seedDatabase(tx: Tx, files: SeedFiles): Promise<SeedCounts> {
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
    await tx
      .insert(ingredientAlias)
      .values([...wanted].map(([alias, canonicalId]) => ({ alias, canonicalId, source: "hand" })))
      .onConflictDoNothing({ target: ingredientAlias.alias });

    // An alias that already points somewhere else (added in review, say) is not
    // silently re-pointed: that is exactly how an allergen would move.
    const existing = await tx
      .select({ alias: ingredientAlias.alias, canonicalId: ingredientAlias.canonicalId })
      .from(ingredientAlias)
      .where(inArray(ingredientAlias.alias, [...wanted.keys()]));
    const conflicts = existing.filter((row) => wanted.get(row.alias) !== row.canonicalId);
    if (conflicts.length > 0) {
      throw new Error(
        `aliases already point at a different ingredient: ${conflicts.map((c) => c.alias).join(", ")}`,
      );
    }
  }

  // Resolve against the database, not the files: it also holds aliases added in review.
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

  return counts;
}
