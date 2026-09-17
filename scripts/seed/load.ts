import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";
import { inArray } from "drizzle-orm";
import type { z } from "zod";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { leavesSchema, recipesSchema } from "@/lib/ai/prompts/seed-catalogue";
import {
  canonicalIngredient,
  ingredientAlias,
  recipe,
  recipeIngredient,
  recipeStep,
} from "@/lib/db/schema";
import { buildNameIndex, deriveRecipeStatus, resolveTerm } from "@/lib/domain/resolution";
import { taxonomySchema, validateTaxonomy } from "@/lib/domain/taxonomy";

/**
 * `pnpm seed`: loads the committed JSON. Needs only DATABASE_URL — no network, no
 * API key — so the same command seeds a clean clone and production.
 *
 * Safe to run repeatedly: nodes upsert by name, aliases by alias, and a recipe whose
 * title already exists is skipped, all in one transaction, so a second run changes
 * nothing — and never undoes a draft someone has since promoted in review.
 */

config({ path: ".env.local", quiet: true });

// Same default as drizzle.config.ts, so the clean-clone path needs no .env.local.
const url = process.env.DATABASE_URL ?? "postgresql://mise:mise@localhost:5432/mise";

// The fallback means an unset DATABASE_URL still succeeds, so say where the rows went —
// otherwise a production seed missing its URL reports success against localhost.
function target(connection: string): string {
  try {
    const parsed = new URL(connection);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "an unparseable DATABASE_URL";
  }
}

function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(JSON.parse(readFileSync(resolve(__dirname, file), "utf8")));
  if (parsed.success) return parsed.data;
  console.error(`${file} doesn't match its schema:`);
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  return null;
}

async function main(): Promise<number> {
  const taxonomy = readJson("taxonomy.json", taxonomySchema);
  const leaves = readJson("leaves.json", leavesSchema);
  const catalogue = readJson("recipes.json", recipesSchema);
  if (!taxonomy || !leaves || !catalogue) return 1;

  // Generated leaves are validated with the hand-authored tree, not beside it, so a
  // leaf can't take a hand-authored name or hang under a node that doesn't exist.
  const validation = validateTaxonomy({ nodes: [...taxonomy.nodes, ...leaves.nodes] });
  if (!validation.ok) {
    console.error("taxonomy.json and leaves.json don't form a valid tree:");
    for (const error of validation.errors) console.error(`  ${error}`);
    return 1;
  }

  const statuses = { draft: 0, published: 0 };
  let skipped = 0;

  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(client);
    await db.transaction(async (tx) => {
      const ids = new Map<string, string>();
      for (const node of validation.nodes) {
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
      for (const node of validation.nodes) {
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
      for (const entry of catalogue.recipes) {
        if (titles.has(entry.title.toLowerCase())) {
          skipped++;
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
        statuses[status]++;

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
    });

    const nodeCount = validation.nodes.length;
    const aliasCount = validation.nodes.reduce((sum, n) => sum + n.aliases.length, 0);
    console.log(`Seeded taxonomy into ${target(url)}: ${nodeCount} ingredients, ${aliasCount} aliases.`);
    console.log(
      `Recipes: ${statuses.published} published, ${statuses.draft} draft, ${skipped} already present.`,
    );
    return 0;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
