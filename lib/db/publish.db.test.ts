// @gate resolution
import { randomUUID } from "node:crypto";

import { eq, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { findCandidateRecipes } from "./candidates";
import type { Tx } from "./drafts";
import { publishDraft } from "./publish";
import * as schema from "./schema";

/**
 * The publish gate against Postgres. An unresolved line is where an allergen hides, so a
 * draft holding one must stay a draft however the request arrives — and a draft that
 * clears the check must become a row gate 2 can actually return.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. pnpm test:db needs docker compose up -d, pnpm db:push and .env.local.",
  );
}

const client = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });

afterAll(() => client.end());

// Every write rolls back, so the suite neither needs nor disturbs seed data.
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

type Ingredients = { dairy: string; cauliflower: string };

async function ingredients(tx: Tx): Promise<Ingredients> {
  // canonical_ingredient.name is unique and the database may already hold the seed.
  const suffix = randomUUID().slice(0, 8);
  const [dairy] = await tx
    .insert(schema.canonicalIngredient)
    .values({ name: `dairy ${suffix}`, allergenTags: ["dairy"] })
    .returning({ id: schema.canonicalIngredient.id });
  const [cauliflower] = await tx
    .insert(schema.canonicalIngredient)
    .values({ name: `cauliflower ${suffix}` })
    .returning({ id: schema.canonicalIngredient.id });
  if (!dairy || !cauliflower) throw new Error("no ingredient rows");
  return { dairy: dairy.id, cauliflower: cauliflower.id };
}

type Line = { canonicalId: string | null; rawText: string; optional?: boolean };

async function addRecipe(
  tx: Tx,
  status: "draft" | "published",
  lines: Line[],
  extractionJobId: string | null = null,
): Promise<{ recipeId: string; lineIds: string[] }> {
  const [row] = await tx
    .insert(schema.recipe)
    .values({ title: `fixture ${randomUUID()}`, status, extractionJobId })
    .returning({ id: schema.recipe.id });
  if (!row) throw new Error("no recipe row");
  // Drizzle refuses an empty `values()`, and a recipe with no lines is a case under test.
  if (lines.length === 0) return { recipeId: row.id, lineIds: [] };
  const inserted = await tx
    .insert(schema.recipeIngredient)
    .values(
      lines.map((line) => ({
        recipeId: row.id,
        canonicalId: line.canonicalId,
        rawText: line.rawText,
        optional: line.optional ?? false,
      })),
    )
    .returning({ id: schema.recipeIngredient.id });
  return { recipeId: row.id, lineIds: inserted.map((l) => l.id) };
}

async function addJob(tx: Tx): Promise<string> {
  const [job] = await tx
    .insert(schema.extractionJob)
    .values({
      sourceKind: "text",
      rawInput: `fixture ${randomUUID()}`,
      model: "claude-sonnet-4-5",
      promptVersion: "1",
      status: "awaiting_review",
    })
    .returning({ id: schema.extractionJob.id });
  if (!job) throw new Error("no job row");
  return job.id;
}

async function statusOf(tx: Tx, recipeId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ status: schema.recipe.status })
    .from(schema.recipe)
    .where(eq(schema.recipe.id, recipeId));
  return row?.status;
}

async function jobStatusOf(tx: Tx, jobId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ status: schema.extractionJob.status })
    .from(schema.extractionJob)
    .where(eq(schema.extractionJob.id, jobId));
  return row?.status;
}

describe("publishDraft", () => {
  it("refuses a draft holding an unresolved line, names it, and leaves the draft a draft", async () => {
    await inRollback(async (tx) => {
      const t = await ingredients(tx);
      const jobId = await addJob(tx);
      const { recipeId, lineIds } = await addRecipe(
        tx,
        "draft",
        [
          { canonicalId: t.cauliflower, rawText: "1 cauliflower" },
          { canonicalId: null, rawText: "2 tbsp ghee, melted" },
        ],
        jobId,
      );

      await expect(publishDraft(tx, recipeId)).resolves.toEqual({
        kind: "unresolved",
        lines: [{ id: lineIds[1], rawText: "2 tbsp ghee, melted" }],
      });
      expect(await statusOf(tx, recipeId)).toBe("draft");
      expect(await jobStatusOf(tx, jobId)).toBe("awaiting_review");
    });
  });

  it("refuses when the only unresolved line is optional", async () => {
    // Optional ghee is still ghee: an optional ingredient nobody can identify can still
    // carry an allergen, which is the rule `deriveRecipeStatus` already states.
    await inRollback(async (tx) => {
      const t = await ingredients(tx);
      const { recipeId, lineIds } = await addRecipe(tx, "draft", [
        { canonicalId: t.cauliflower, rawText: "1 cauliflower" },
        { canonicalId: null, rawText: "ghee, to finish", optional: true },
      ]);

      await expect(publishDraft(tx, recipeId)).resolves.toEqual({
        kind: "unresolved",
        lines: [{ id: lineIds[1], rawText: "ghee, to finish" }],
      });
      expect(await statusOf(tx, recipeId)).toBe("draft");
    });
  });

  it("refuses a draft with no ingredient lines and leaves it a draft", async () => {
    // No line is unresolved because there is no line: the contents are wholly unknown, and
    // published, the recipe would pass every exclusion gate 2 can express.
    await inRollback(async (tx) => {
      const jobId = await addJob(tx);
      const { recipeId } = await addRecipe(tx, "draft", [], jobId);

      await expect(publishDraft(tx, recipeId)).resolves.toEqual({ kind: "no_ingredients" });
      expect(await statusOf(tx, recipeId)).toBe("draft");
      expect(await jobStatusOf(tx, jobId)).toBe("awaiting_review");
    });
  });

  it("publishes a fully resolved draft, which gate 2 then returns", async () => {
    await inRollback(async (tx) => {
      const t = await ingredients(tx);
      const { recipeId } = await addRecipe(tx, "draft", [
        { canonicalId: t.cauliflower, rawText: "1 cauliflower" },
      ]);

      // Before: a draft is in no Cook result, filtered or not.
      expect((await findCandidateRecipes(tx, [t.dairy])).map((r) => r.id)).not.toContain(recipeId);

      await expect(publishDraft(tx, recipeId)).resolves.toEqual({ kind: "published" });
      expect(await statusOf(tx, recipeId)).toBe("published");

      // A query that excludes something, just not anything this recipe holds.
      expect((await findCandidateRecipes(tx, [t.dairy])).map((r) => r.id)).toContain(recipeId);
      expect((await findCandidateRecipes(tx, [])).map((r) => r.id)).toContain(recipeId);
    });
  });

  it("moves an Intake draft's extraction job to promoted in the same write", async () => {
    await inRollback(async (tx) => {
      const t = await ingredients(tx);
      const jobId = await addJob(tx);
      const { recipeId } = await addRecipe(
        tx,
        "draft",
        [{ canonicalId: t.cauliflower, rawText: "1 cauliflower" }],
        jobId,
      );

      await expect(publishDraft(tx, recipeId)).resolves.toEqual({ kind: "published" });
      expect(await jobStatusOf(tx, jobId)).toBe("promoted");
    });
  });

  it("publishes a seeded draft that has no extraction job", async () => {
    await inRollback(async (tx) => {
      const t = await ingredients(tx);
      const { recipeId } = await addRecipe(tx, "draft", [
        { canonicalId: t.cauliflower, rawText: "1 cauliflower" },
      ]);

      await expect(publishDraft(tx, recipeId)).resolves.toEqual({ kind: "published" });
      expect(await statusOf(tx, recipeId)).toBe("published");
    });
  });

  it("refuses a recipe that is already published", async () => {
    await inRollback(async (tx) => {
      const t = await ingredients(tx);
      const { recipeId } = await addRecipe(tx, "published", [
        { canonicalId: t.cauliflower, rawText: "1 cauliflower" },
      ]);

      await expect(publishDraft(tx, recipeId)).resolves.toEqual({ kind: "already_published" });
      expect(await statusOf(tx, recipeId)).toBe("published");
    });
  });

  it("reports an id that is no recipe as not found", async () => {
    await inRollback(async (tx) => {
      await expect(publishDraft(tx, randomUUID())).resolves.toEqual({ kind: "not_found" });
    });
  });
});
