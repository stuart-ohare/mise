import { eq, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import type { IntakeDraft } from "@/lib/domain/intake-draft";

import { writeIntakeDraft, type Tx } from "./drafts";
import * as schema from "./schema";

/**
 * What one Intake submission leaves behind: a job awaiting a human, and a recipe that
 * can't publish itself. The unit tests pin what `buildIntakeDraft` decides; this pins
 * that Postgres stores the decision — the null canonical id, the untouched raw text, and
 * the draft status that keeps an unreviewed recipe out of every Cook query.
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

async function butterId(tx: Tx): Promise<string> {
  const [row] = await tx
    .insert(schema.canonicalIngredient)
    .values({ name: `butter ${crypto.randomUUID()}`, allergenTags: ["dairy"] })
    .returning({ id: schema.canonicalIngredient.id });
  if (!row) throw new Error("no ingredient row");
  return row.id;
}

function draftWith(canonicalId: string): IntakeDraft {
  return {
    recipe: { title: `Chard and beans ${crypto.randomUUID()}`, serves: 2, minutes: 25, status: "draft" },
    ingredients: [
      {
        canonicalId,
        canonicalName: "butter",
        rawText: "a knob of butter",
        qty: null,
        unit: null,
        optional: false,
        confidence: 0.6,
      },
      {
        canonicalId: null,
        canonicalName: null,
        rawText: "  2 tbsp ghee, melted ",
        qty: 2.5,
        unit: "tbsp",
        optional: true,
        confidence: 0.95,
      },
    ],
    steps: [
      { position: 1, text: "Warm the beans." },
      { position: 2, text: "Wilt the chard." },
    ],
    unresolved: ["  2 tbsp ghee, melted "],
    fieldConfidence: {
      title: 0.9,
      serves: 0.7,
      minutes: 0.5,
      ingredients: [
        { rawText: "a knob of butter", confidence: 0.6 },
        { rawText: "  2 tbsp ghee, melted ", confidence: 0.95 },
      ],
    },
  };
}

const write = (tx: Tx, draft: IntakeDraft) =>
  writeIntakeDraft(tx, {
    rawInput: "  Chard and beans\n\na knob of butter\n2 tbsp ghee, melted  ",
    model: "claude-sonnet-4-5",
    promptVersion: "1",
    output: { title: draft.recipe.title },
    draft,
  });

describe("writeIntakeDraft", () => {
  it("writes one job awaiting review and one draft recipe pointing at it", async () => {
    await inRollback(async (tx) => {
      const draft = draftWith(await butterId(tx));
      const { jobId, recipeId } = await write(tx, draft);

      const jobs = await tx
        .select()
        .from(schema.extractionJob)
        .where(eq(schema.extractionJob.id, jobId));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        sourceKind: "text",
        status: "awaiting_review",
        model: "claude-sonnet-4-5",
        promptVersion: "1",
        // The paste as it arrived, whitespace and all.
        rawInput: "  Chard and beans\n\na knob of butter\n2 tbsp ghee, melted  ",
        fieldConfidence: draft.fieldConfidence,
      });

      const recipes = await tx.select().from(schema.recipe).where(eq(schema.recipe.id, recipeId));
      expect(recipes).toHaveLength(1);
      expect(recipes[0]).toMatchObject({
        title: draft.recipe.title,
        serves: 2,
        minutes: 25,
        status: "draft",
        extractionJobId: jobId,
      });
    });
  });

  it("stores an unresolved line as a null canonical id with its raw text intact", async () => {
    await inRollback(async (tx) => {
      const canonicalId = await butterId(tx);
      const { recipeId } = await write(tx, draftWith(canonicalId));

      const lines = await tx
        .select()
        .from(schema.recipeIngredient)
        .where(eq(schema.recipeIngredient.recipeId, recipeId));

      expect(lines).toHaveLength(2);
      expect(lines.map((l) => [l.rawText, l.canonicalId, l.qty, l.unit, l.optional])).toEqual(
        expect.arrayContaining([
          // An unstated quantity is null in the column, not zero.
          ["a knob of butter", canonicalId, null, null, false],
          // Ghee resolves to nothing, and every character of the line survives.
          ["  2 tbsp ghee, melted ", null, "2.5", "tbsp", true],
        ]),
      );
    });
  });

  it("writes the steps in order, numbered from one", async () => {
    await inRollback(async (tx) => {
      const { recipeId } = await write(tx, draftWith(await butterId(tx)));

      const steps = await tx
        .select()
        .from(schema.recipeStep)
        .where(eq(schema.recipeStep.recipeId, recipeId));

      expect(steps.map((s) => [s.position, s.text]).sort()).toEqual([
        [1, "Warm the beans."],
        [2, "Wilt the chard."],
      ]);
    });
  });

  it("leaves no job behind when the recipe rows can't be written", async () => {
    await inRollback(async (tx) => {
      // A canonical id that is in no row: the foreign key rejects the ingredient insert
      // after the job has already been written. Inside one transaction the job must go
      // with it, rather than sit in the queue holding nothing a reviewer can open.
      const marker = `orphan ${crypto.randomUUID()}`;
      const draft = draftWith(crypto.randomUUID());

      await expect(
        tx.transaction((inner) =>
          writeIntakeDraft(inner, {
            rawInput: marker,
            model: "claude-sonnet-4-5",
            promptVersion: "1",
            output: null,
            draft,
          }),
        ),
      ).rejects.toThrow();

      const jobs = await tx
        .select()
        .from(schema.extractionJob)
        .where(eq(schema.extractionJob.rawInput, marker));
      expect(jobs).toEqual([]);
    });
  });
});
