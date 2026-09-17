import { randomUUID } from "node:crypto";

import { count, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

import { readSeedFiles, seedDatabase, type SeedFiles, type Tx } from "./seed";

// Gate 1 resolves a term against every name and alias in the database. A term that
// belongs to two ingredients has no safe answer, so the seed must refuse to create one
// — whichever side of the collision was there first — and write nothing.

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. pnpm test:db needs docker compose up -d, pnpm db:push and .env.local.",
  );
}

const client = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });

afterAll(() => client.end());

let files: SeedFiles;
beforeAll(() => {
  const read = readSeedFiles();
  if (!read.ok) throw new Error(read.errors.join("\n"));
  files = read.files;
});

// Every write rolls back, so the suite passes whether or not the database holds the seed.
async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
}

async function rowCounts(tx: Tx) {
  const [nodes] = await tx.select({ n: count() }).from(schema.canonicalIngredient);
  const [aliases] = await tx.select({ n: count() }).from(schema.ingredientAlias);
  const [recipes] = await tx.select({ n: count() }).from(schema.recipe);
  return { nodes: nodes?.n, aliases: aliases?.n, recipes: recipes?.n };
}

async function addNode(tx: Tx, name: string): Promise<string> {
  const [row] = await tx
    .insert(schema.canonicalIngredient)
    .values({ name })
    .returning({ id: schema.canonicalIngredient.id });
  if (!row) throw new Error(`insert of "${name}" returned no row`);
  return row.id;
}

describe("seedDatabase", () => {
  it("seeds the committed files", async () => {
    await inRollback(async (tx) => {
      const result = await seedDatabase(tx, files);
      expect(result.ok).toBe(true);
    });
  });

  it("refuses an alias that is already an ingredient's name", async () => {
    await inRollback(async (tx) => {
      await addNode(tx, "shrimp");
      const before = await rowCounts(tx);

      const result = await seedDatabase(tx, files);

      expect(result).toMatchObject({
        ok: false,
        collisions: expect.arrayContaining([{ term: "shrimp", ingredients: ["prawn", "shrimp"] }]),
      });
      expect(await rowCounts(tx)).toEqual(before);
    });
  });

  it("refuses a node named after an existing alias", async () => {
    await inRollback(async (tx) => {
      const fixture = `fixture ${randomUUID()}`;
      const id = await addNode(tx, fixture);
      await tx.insert(schema.ingredientAlias).values({ alias: "pasta", canonicalId: id });
      const before = await rowCounts(tx);

      const result = await seedDatabase(tx, files);

      expect(result).toMatchObject({
        ok: false,
        collisions: expect.arrayContaining([{ term: "pasta", ingredients: [fixture, "pasta"] }]),
      });
      expect(await rowCounts(tx)).toEqual(before);
    });
  });

  it("refuses to re-point an existing alias", async () => {
    await inRollback(async (tx) => {
      const fixture = `fixture ${randomUUID()}`;
      const id = await addNode(tx, fixture);
      // Upsert: a seeded database already has `prawns` pointing at prawn.
      await tx
        .insert(schema.ingredientAlias)
        .values({ alias: "prawns", canonicalId: id })
        .onConflictDoUpdate({ target: schema.ingredientAlias.alias, set: { canonicalId: id } });
      const before = await rowCounts(tx);

      const result = await seedDatabase(tx, files);

      expect(result).toMatchObject({
        ok: false,
        collisions: expect.arrayContaining([{ term: "prawns", ingredients: [fixture, "prawn"] }]),
      });
      expect(await rowCounts(tx)).toEqual(before);
    });
  });
});
