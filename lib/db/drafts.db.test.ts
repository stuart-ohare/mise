import { eq, inArray, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { DELIBERATELY_UNRESOLVED } from "@/lib/ai/prompts/seed-catalogue";
import type { IntakeDraft } from "@/lib/domain/intake-draft";
import { readSeedFiles, seedDatabase } from "@/scripts/seed/seed";

import { listDrafts, writeIntakeDraft, type Tx } from "./drafts";
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
        name: "butter",
        qty: null,
        unit: null,
        optional: false,
        confidence: 0.6,
      },
      {
        canonicalId: null,
        canonicalName: null,
        rawText: "  2 tbsp ghee, melted ",
        name: "ghee",
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

/**
 * `rawInput` carries a unique marker so a count over it is a count of the rows this call
 * wrote. Selecting by the id the write returned would only ever find the row it named,
 * which is no evidence about how many rows it made.
 */
const paste = (marker: string) =>
  `  Chard and beans ${marker}\n\na knob of butter\n2 tbsp ghee, melted  `;

const write = (tx: Tx, draft: IntakeDraft, marker: string) =>
  writeIntakeDraft(tx, {
    sourceKind: "text",
    rawInput: paste(marker),
    model: "claude-sonnet-4-5",
    promptVersion: "1",
    output: { title: draft.recipe.title },
    draft,
  });

describe("writeIntakeDraft", () => {
  it("writes exactly one job awaiting review and one draft recipe pointing at it", async () => {
    await inRollback(async (tx) => {
      const marker = crypto.randomUUID();
      const draft = draftWith(await butterId(tx));
      const { jobId, recipeId } = await write(tx, draft, marker);

      // Counted over the marker, not over the returned id: "exactly one" is the claim,
      // and a second job row written by the same call has to be able to fail this.
      const jobs = await tx
        .select()
        .from(schema.extractionJob)
        .where(eq(schema.extractionJob.rawInput, paste(marker)));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: jobId,
        sourceKind: "text",
        status: "awaiting_review",
        model: "claude-sonnet-4-5",
        promptVersion: "1",
        // The paste as it arrived, whitespace and all.
        rawInput: paste(marker),
        fieldConfidence: draft.fieldConfidence,
      });

      const recipes = await tx
        .select()
        .from(schema.recipe)
        .where(eq(schema.recipe.extractionJobId, jobId));
      expect(recipes).toHaveLength(1);
      expect(recipes[0]).toMatchObject({
        id: recipeId,
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
      const { recipeId } = await write(tx, draftWith(canonicalId), crypto.randomUUID());

      const lines = await tx
        .select()
        .from(schema.recipeIngredient)
        .where(eq(schema.recipeIngredient.recipeId, recipeId));

      expect(lines).toHaveLength(2);
      expect(lines.map((l) => [l.rawText, l.name, l.canonicalId, l.qty, l.unit, l.optional])).toEqual(
        expect.arrayContaining([
          // An unstated quantity is null in the column, not zero.
          ["a knob of butter", "butter", canonicalId, null, null, false],
          // Ghee resolves to nothing, and every character of the line survives — as does
          // the term it failed on, so an alias added in review can find it again.
          ["  2 tbsp ghee, melted ", "ghee", null, "2.5", "tbsp", true],
        ]),
      );
    });
  });

  it("writes the steps in order, numbered from one", async () => {
    await inRollback(async (tx) => {
      const { recipeId } = await write(tx, draftWith(await butterId(tx)), crypto.randomUUID());

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
            sourceKind: "text",
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

  it("records a photographed card as an image, with the same draft shape", async () => {
    await inRollback(async (tx) => {
      const marker = crypto.randomUUID();
      const draft = draftWith(await butterId(tx));
      // The data URI stands in for the card. What is asserted is the column and the
      // shape, not the pixels — the model never runs in a database test.
      const card = `data:image/png;base64,iVBORw0KGgo=${marker}`;

      const { jobId, recipeId } = await writeIntakeDraft(tx, {
        sourceKind: "image",
        rawInput: card,
        model: "claude-sonnet-4-5",
        promptVersion: "2",
        output: { title: draft.recipe.title },
        draft,
      });

      const jobs = await tx
        .select()
        .from(schema.extractionJob)
        .where(eq(schema.extractionJob.rawInput, card));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: jobId,
        sourceKind: "image",
        status: "awaiting_review",
        // The card itself, kept whole: /review shows a reviewer what the model read.
        rawInput: card,
      });

      // Same shape as the text path, and the part that matters most: the ghee line is
      // still unresolved, so this recipe is still a draft.
      const recipes = await tx.select().from(schema.recipe).where(eq(schema.recipe.id, recipeId));
      expect(recipes[0]).toMatchObject({ status: "draft", extractionJobId: jobId });

      const lines = await tx
        .select()
        .from(schema.recipeIngredient)
        .where(eq(schema.recipeIngredient.recipeId, recipeId));
      expect(lines).toHaveLength(draft.ingredients.length);
      // Taken from the draft rather than retyped: the claim is that the row kept what
      // the model read, whitespace and all, not that it matches a tidied copy.
      expect(lines.filter((line) => line.canonicalId === null)).toMatchObject(
        draft.ingredients
          .filter((line) => line.canonicalId === null)
          .map((line) => ({ rawText: line.rawText })),
      );
    });
  });
});

/**
 * The seed's deliberately missing aliases (scripts/seed/README.md): each recipe is held in
 * draft by exactly this line, and it is the line a reviewer has to see verbatim.
 */
const HELD_BY = {
  "Spiced lentil dal with ghee": "2 tbsp ghee",
  "Crispy panko fish fillets": "100g panko",
  "Brinjal and tomato curry": "2 large brinjal, cubed",
} as const;

describe("listDrafts", () => {
  it("returns each seeded draft held by an unresolved term, raw text intact", async () => {
    await inRollback(async (tx) => {
      // Removed and re-seeded rather than trusted: once review can publish (#81), a local
      // database may hold these as published, and this is a claim about what the seed writes.
      const titles = Object.keys(HELD_BY);
      await tx.delete(schema.recipe).where(inArray(schema.recipe.title, titles));
      // Likewise an alias a reviewer added for one of these terms (#82), which the seed
      // resolves against and which would publish the very draft this test is about.
      await tx
        .delete(schema.ingredientAlias)
        .where(inArray(schema.ingredientAlias.alias, [...DELIBERATELY_UNRESOLVED]));
      const files = readSeedFiles();
      if (!files.ok) throw new Error(files.errors.join("\n"));
      const seeded = await seedDatabase(tx, files.files);
      expect(seeded.ok).toBe(true);

      const drafts = await listDrafts(tx);

      for (const [title, rawText] of Object.entries(HELD_BY)) {
        const draft = drafts.find((d) => d.title === title);
        expect(draft, title).toMatchObject({ status: "draft", source: "seed", fieldConfidence: null });
        const unresolved = draft?.lines.filter((line) => line.canonicalId === null) ?? [];
        expect(unresolved.map((line) => line.rawText)).toEqual([rawText]);
        // The blocker leads the table, whatever else the recipe lists.
        expect(draft?.lines[0]?.rawText).toBe(rawText);
      }
    });
  });

  it("returns no published recipe, even one with an unresolved line", async () => {
    await inRollback(async (tx) => {
      // The row most likely to leak: it looks exactly like a draft apart from its status.
      const [row] = await tx
        .insert(schema.recipe)
        .values({ title: `Published ${crypto.randomUUID()}`, status: "published" })
        .returning({ id: schema.recipe.id });
      if (!row) throw new Error("no recipe row");
      await tx.insert(schema.recipeIngredient).values({ recipeId: row.id, rawText: "a knob of ghee", name: "ghee" });
      // A draft of its own, so the `every` below can't pass on an empty queue.
      const { recipeId } = await write(tx, draftWith(await butterId(tx)), crypto.randomUUID());

      const drafts = await listDrafts(tx);

      expect(drafts.map((d) => d.id)).toContain(recipeId);
      expect(drafts.map((d) => d.id)).not.toContain(row.id);
      expect(drafts.every((d) => d.status === "draft")).toBe(true);
    });
  });

  // @gate resolution
  it("names a resolved line's canonical ingredient and leaves an unresolved line null", async () => {
    await inRollback(async (tx) => {
      const canonicalId = await butterId(tx);
      const draft = draftWith(canonicalId);
      const { recipeId } = await write(tx, draft, crypto.randomUUID());

      const queued = (await listDrafts(tx)).find((d) => d.id === recipeId);

      expect(queued).toMatchObject({
        source: "intake",
        title: draft.recipe.title,
        serves: 2,
        minutes: 25,
        fieldConfidence: draft.fieldConfidence,
      });
      const [name] = await tx
        .select({ name: schema.canonicalIngredient.name })
        .from(schema.canonicalIngredient)
        .where(eq(schema.canonicalIngredient.id, canonicalId));
      expect(queued?.lines).toEqual([
        // Unresolved first. Null, not "" and not a name read back out of the raw text.
        {
          rawText: "  2 tbsp ghee, melted ",
          name: "ghee",
          canonicalId: null,
          canonicalName: null,
          qty: "2.5",
          unit: "tbsp",
          optional: true,
        },
        // The name comes from the canonical row, not from what extraction called it.
        {
          rawText: "a knob of butter",
          name: "butter",
          canonicalId,
          canonicalName: name?.name,
          qty: null,
          unit: null,
          optional: false,
        },
      ]);
      expect(name?.name).not.toBe("butter");
    });
  });
});
