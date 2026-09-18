import { randomUUID } from "node:crypto";

import { count, eq, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

import { readSeedFiles, seedDatabase, type SeedFiles, type Tx } from "./seed";

// Gate 1 resolves a term against every name and alias in the database. A term that
// belongs to two ingredients has no safe answer, so the seed must refuse to create one
// — whichever side of the collision was there first — and write nothing.
//
// Gate 2 walks the ingredient tree. Re-parenting a node, or changing its tags, moves every
// recipe under it into or out of an exclusion, so the seed refuses to overwrite an existing
// node's parent or tags unless it is asked to.

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

async function idOf(tx: Tx, name: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: schema.canonicalIngredient.id })
    .from(schema.canonicalIngredient)
    .where(eq(schema.canonicalIngredient.name, name));
  return row?.id;
}

async function nodeOf(tx: Tx, name: string) {
  const [row] = await tx
    .select({ parentId: schema.canonicalIngredient.parentId, allergenTags: schema.canonicalIngredient.allergenTags })
    .from(schema.canonicalIngredient)
    .where(eq(schema.canonicalIngredient.name, name));
  if (!row) throw new Error(`no node "${name}"`);
  return row;
}

// The tree cases need existing nodes to differ from, so they seed first if the database is empty.
async function ensureSeeded(tx: Tx): Promise<void> {
  if (await idOf(tx, "pasta")) return;
  const result = await seedDatabase(tx, files);
  if (!result.ok) throw new Error("the committed files don't seed an empty database");
}

async function moveUnder(tx: Tx, name: string, parent: string): Promise<string> {
  const parentId = await idOf(tx, parent);
  if (!parentId) throw new Error(`no node "${parent}"`);
  await tx
    .update(schema.canonicalIngredient)
    .set({ parentId })
    .where(eq(schema.canonicalIngredient.name, name));
  return parentId;
}

async function setTags(tx: Tx, name: string, allergenTags: string[]): Promise<void> {
  await tx
    .update(schema.canonicalIngredient)
    .set({ allergenTags })
    .where(eq(schema.canonicalIngredient.name, name));
}

describe("seedDatabase", () => {
  it("seeds the committed files", async () => {
    await inRollback(async (tx) => {
      const result = await seedDatabase(tx, files);
      expect(result.ok).toBe(true);
    });
  });

  // @gate resolution
  it("stores the term each line was resolved on, so a line that missed can be found again", async () => {
    await inRollback(async (tx) => {
      // Removed and re-seeded, as listDrafts' test does: a local database may already
      // hold this recipe, and this is a claim about what the seed writes.
      const title = "Spiced lentil dal with ghee";
      await tx.delete(schema.recipe).where(eq(schema.recipe.title, title));
      expect((await seedDatabase(tx, files)).ok).toBe(true);

      const [dal] = await tx.select({ id: schema.recipe.id }).from(schema.recipe).where(eq(schema.recipe.title, title));
      if (!dal) throw new Error(`"${title}" was not seeded`);
      const lines = await tx
        .select({
          name: schema.recipeIngredient.name,
          rawText: schema.recipeIngredient.rawText,
          canonicalId: schema.recipeIngredient.canonicalId,
        })
        .from(schema.recipeIngredient)
        .where(eq(schema.recipeIngredient.recipeId, dal.id));

      // The name, not the line: "2 tbsp ghee" is what a reviewer reads, "ghee" is what an
      // alias has to match.
      expect(lines.filter((l) => l.canonicalId === null)).toEqual([
        { name: "ghee", rawText: "2 tbsp ghee", canonicalId: null },
      ]);
      const entry = files.recipes.find((r) => r.title === title);
      expect(lines.map((l) => l.name).sort()).toEqual(entry?.ingredients.map((i) => i.name).sort());
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
        treeChanges: [],
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
        treeChanges: [],
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
        treeChanges: [],
      });
      expect(await rowCounts(tx)).toEqual(before);
    });
  });

  it("refuses to re-parent an existing node", async () => {
    await inRollback(async (tx) => {
      await ensureSeeded(tx);
      const glutenId = await moveUnder(tx, "pasta", "gluten");
      const before = await rowCounts(tx);

      const result = await seedDatabase(tx, files);

      expect(result).toEqual({
        ok: false,
        collisions: [],
        treeChanges: [{ name: "pasta", parent: { from: "gluten", to: "wheat" } }],
      });
      expect(await rowCounts(tx)).toEqual(before);
      expect((await nodeOf(tx, "pasta")).parentId).toBe(glutenId);
    });
  });

  it("refuses to change an existing node's tags", async () => {
    await inRollback(async (tx) => {
      await ensureSeeded(tx);
      await setTags(tx, "miso", []);
      const before = await rowCounts(tx);

      const result = await seedDatabase(tx, files);

      expect(result).toEqual({
        ok: false,
        collisions: [],
        treeChanges: [{ name: "miso", tags: { from: [], to: ["gluten"] } }],
      });
      expect(await rowCounts(tx)).toEqual(before);
      expect((await nodeOf(tx, "miso")).allergenTags).toEqual([]);
    });
  });

  it("applies tree changes when asked", async () => {
    await inRollback(async (tx) => {
      await ensureSeeded(tx);
      await moveUnder(tx, "pasta", "gluten");
      await setTags(tx, "miso", []);

      const result = await seedDatabase(tx, files, { applyTreeChanges: true });

      expect(result).toMatchObject({
        ok: true,
        treeChanges: [
          { name: "miso", tags: { from: [], to: ["gluten"] } },
          { name: "pasta", parent: { from: "gluten", to: "wheat" } },
        ],
      });
      expect((await nodeOf(tx, "pasta")).parentId).toBe(await idOf(tx, "wheat"));
      expect((await nodeOf(tx, "miso")).allergenTags).toEqual(["gluten"]);
    });
  });

  it("still refuses a term collision when applying tree changes", async () => {
    await inRollback(async (tx) => {
      await ensureSeeded(tx);
      const glutenId = await moveUnder(tx, "pasta", "gluten");
      await addNode(tx, "shrimp");
      const before = await rowCounts(tx);

      const result = await seedDatabase(tx, files, { applyTreeChanges: true });

      expect(result).toMatchObject({
        ok: false,
        collisions: expect.arrayContaining([{ term: "shrimp", ingredients: ["prawn", "shrimp"] }]),
      });
      expect(await rowCounts(tx)).toEqual(before);
      expect((await nodeOf(tx, "pasta")).parentId).toBe(glutenId);
    });
  });
});
