import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/lib/db/schema";

import { readSeedFiles, seedDatabase } from "./seed";

/**
 * `pnpm seed`: loads the committed JSON. Needs only DATABASE_URL — no network, no
 * API key — so the same command seeds a clean clone and production. Everything is
 * written in one transaction; the rules live in `seed.ts`.
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

async function main(): Promise<number> {
  const read = readSeedFiles();
  if (!read.ok) {
    for (const line of read.errors) console.error(line);
    return 1;
  }
  const { files } = read;

  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(client, { schema });
    const counts = await db.transaction((tx) => seedDatabase(tx, files));

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
