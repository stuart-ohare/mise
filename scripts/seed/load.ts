import { parseArgs } from "node:util";

import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/lib/db/schema";

import type { TreeChange } from "@/lib/domain/tree-changes";

import { readSeedFiles, seedDatabase } from "./seed";

/**
 * `pnpm seed`: loads the committed JSON. Needs only DATABASE_URL — no network, no
 * API key — so the same command seeds a clean clone and production. Everything is
 * written in one transaction; the rules live in `seed.ts`.
 *
 * `--apply-tree-changes` lets it overwrite an existing ingredient's parent or tags. Run
 * without it first: the refusal lists exactly what the flag would change.
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

function describe(change: TreeChange): string {
  const parent = (name: string | null) => (name === null ? "(root)" : `"${name}"`);
  const parts: string[] = [];
  if (change.parent) parts.push(`parent ${parent(change.parent.from)} → ${parent(change.parent.to)}`);
  if (change.tags) parts.push(`tags [${change.tags.from.join(", ")}] → [${change.tags.to.join(", ")}]`);
  return `  "${change.name}": ${parts.join(", ")}`;
}

async function main(): Promise<number> {
  const args = parseArgs({ options: { "apply-tree-changes": { type: "boolean", default: false } } });
  const applyTreeChanges = args.values["apply-tree-changes"];

  const read = readSeedFiles();
  if (!read.ok) {
    for (const line of read.errors) console.error(line);
    return 1;
  }
  const { files } = read;

  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(client, { schema });
    const result = await db.transaction((tx) => seedDatabase(tx, files, { applyTreeChanges }));
    if (!result.ok) {
      if (result.collisions.length > 0) {
        console.error("Nothing written: a term would belong to more than one ingredient.");
        for (const { term, ingredients } of result.collisions) {
          const quoted = ingredients.map((i) => `"${i}"`);
          console.error(`  "${term}" is claimed by ${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`);
        }
      }
      if (result.treeChanges.length > 0 && !applyTreeChanges) {
        console.error("Nothing written: existing ingredients differ from the files.");
        for (const change of result.treeChanges) console.error(describe(change));
        console.error("Re-run with --apply-tree-changes to apply them.");
      }
      return 1;
    }
    const { counts, treeChanges } = result;

    if (treeChanges.length > 0) {
      console.log("Applied tree changes:");
      for (const change of treeChanges) console.log(describe(change));
    }

    const aliasCount = files.nodes.reduce((sum, n) => sum + n.aliases.length, 0);
    console.log(`Seeded taxonomy into ${target(url)}: ${files.nodes.length} ingredients, ${aliasCount} aliases.`);
    console.log(
      `Recipes: ${counts.published} published, ${counts.draft} draft, ${counts.skipped} already present.`,
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
