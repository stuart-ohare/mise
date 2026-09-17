import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { canonicalIngredient, ingredientAlias } from "@/lib/db/schema";
import { taxonomySchema, validateTaxonomy } from "@/lib/domain/taxonomy";

/**
 * `pnpm seed`: loads the committed JSON. Needs only DATABASE_URL — no network, no
 * API key — so the same command seeds a clean clone and production.
 *
 * Safe to run repeatedly: nodes upsert by name and aliases by alias, in one
 * transaction, so a second run changes nothing.
 */

config({ path: ".env.local", quiet: true });

// Same default as drizzle.config.ts, so the clean-clone path needs no .env.local.
const url = process.env.DATABASE_URL ?? "postgresql://mise:mise@localhost:5432/mise";

async function main(): Promise<number> {
  const raw: unknown = JSON.parse(readFileSync(resolve(__dirname, "taxonomy.json"), "utf8"));
  const parsed = taxonomySchema.safeParse(raw);
  if (!parsed.success) {
    console.error("taxonomy.json doesn't match its schema:");
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    return 1;
  }
  const validation = validateTaxonomy(parsed.data);
  if (!validation.ok) {
    console.error("taxonomy.json isn't a valid tree:");
    for (const error of validation.errors) console.error(`  ${error}`);
    return 1;
  }

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
      if (wanted.size === 0) return;

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
    });

    const nodeCount = validation.nodes.length;
    const aliasCount = validation.nodes.reduce((sum, n) => sum + n.aliases.length, 0);
    console.log(`Seeded taxonomy: ${nodeCount} ingredients, ${aliasCount} aliases.`);
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
