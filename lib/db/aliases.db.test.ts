// @gate resolution
import { randomUUID } from "node:crypto";

import { eq, inArray, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { addAliasAndReresolve } from "./aliases";
import { findCandidateRecipes } from "./candidates";
import type { Tx } from "./drafts";
import { publishDraft } from "./publish";
import * as schema from "./schema";

/**
 * The repair path for gate 1, against Postgres. A human says what a term means; every
 * draft line held by exactly that term resolves through the tree, in the same
 * transaction as the alias, and nothing is published by it. The story ends where the
 * invariant says it should: the recipe leaves a dairy-free search because its line rolls
 * up to dairy, not because anyone tagged the recipe.
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

type Fixture = { dairy: string; clarifiedButter: string; cauliflower: string; ghee: string; panko: string };

/**
 * dairy → butter → clarified butter, the committed taxonomy's shape. Names and terms
 * carry a suffix because the database may already hold the seed, whose own `ghee` draft
 * line would otherwise be re-resolved too and make every count depend on the seed.
 */
async function fixture(tx: Tx): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const node = async (name: string, parentId: string | null, allergenTags: string[] = []) => {
    const [row] = await tx
      .insert(schema.canonicalIngredient)
      .values({ name: `${name} ${suffix}`, parentId, allergenTags })
      .returning({ id: schema.canonicalIngredient.id });
    if (!row) throw new Error(`no row for ${name}`);
    return row.id;
  };
  const dairy = await node("dairy", null, ["dairy"]);
  const butter = await node("butter", dairy);
  const clarifiedButter = await node("clarified butter", butter);
  const cauliflower = await node("cauliflower", null);
  return { dairy, clarifiedButter, cauliflower, ghee: `ghee ${suffix}`, panko: `panko ${suffix}` };
}

type Line = { name: string; canonicalId?: string | null; rawText?: string };

async function addRecipe(
  tx: Tx,
  status: "draft" | "published",
  lines: Line[],
): Promise<{ recipeId: string; lineIds: string[] }> {
  const [row] = await tx
    .insert(schema.recipe)
    .values({ title: `fixture ${randomUUID()}`, status })
    .returning({ id: schema.recipe.id });
  if (!row) throw new Error("no recipe row");
  const inserted = await tx
    .insert(schema.recipeIngredient)
    .values(
      lines.map((line) => ({
        recipeId: row.id,
        name: line.name,
        canonicalId: line.canonicalId ?? null,
        rawText: line.rawText ?? `some ${line.name}`,
      })),
    )
    .returning({ id: schema.recipeIngredient.id });
  return { recipeId: row.id, lineIds: inserted.map((l) => l.id) };
}

async function canonicalIdsOf(tx: Tx, lineIds: string[]): Promise<(string | null)[]> {
  const rows = await tx
    .select({ id: schema.recipeIngredient.id, canonicalId: schema.recipeIngredient.canonicalId })
    .from(schema.recipeIngredient)
    .where(inArray(schema.recipeIngredient.id, lineIds));
  const byId = new Map(rows.map((r) => [r.id, r.canonicalId]));
  return lineIds.map((id) => byId.get(id) ?? null);
}

async function aliasRowsOf(tx: Tx, alias: string) {
  return tx
    .select({
      alias: schema.ingredientAlias.alias,
      canonicalId: schema.ingredientAlias.canonicalId,
      source: schema.ingredientAlias.source,
    })
    .from(schema.ingredientAlias)
    .where(eq(schema.ingredientAlias.alias, alias));
}

async function statusOf(tx: Tx, recipeId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ status: schema.recipe.status })
    .from(schema.recipe)
    .where(eq(schema.recipe.id, recipeId));
  return row?.status;
}

describe("addAliasAndReresolve", () => {
  it("resolves every draft line named by the alias, counts them, and leaves other null lines alone", async () => {
    await inRollback(async (tx) => {
      const t = await fixture(tx);
      const first = await addRecipe(tx, "draft", [
        { name: t.ghee, rawText: "2 tbsp ghee, melted" },
        { name: t.panko, rawText: "a handful of panko" },
      ]);
      // A second draft, and the term in a different case: the index normalises, so this does.
      const second = await addRecipe(tx, "draft", [{ name: t.ghee.toUpperCase(), rawText: "a knob of ghee" }]);

      await expect(
        addAliasAndReresolve(tx, { alias: t.ghee, canonicalId: t.clarifiedButter }),
      ).resolves.toEqual({ kind: "added", reresolved: 2 });

      expect(await canonicalIdsOf(tx, first.lineIds)).toEqual([t.clarifiedButter, null]);
      expect(await canonicalIdsOf(tx, second.lineIds)).toEqual([t.clarifiedButter]);
    });
  });

  it("writes the alias with extraction provenance", async () => {
    await inRollback(async (tx) => {
      const t = await fixture(tx);

      await addAliasAndReresolve(tx, { alias: t.ghee, canonicalId: t.clarifiedButter });

      expect(await aliasRowsOf(tx, t.ghee)).toEqual([
        { alias: t.ghee, canonicalId: t.clarifiedButter, source: "extraction" },
      ]);
    });
  });

  it("refuses a duplicate alias, however it is spelled, without altering the existing row", async () => {
    await inRollback(async (tx) => {
      const t = await fixture(tx);
      await addAliasAndReresolve(tx, { alias: t.ghee, canonicalId: t.clarifiedButter });

      await expect(
        addAliasAndReresolve(tx, { alias: ` ${t.ghee.toUpperCase()}`, canonicalId: t.cauliflower }),
      ).resolves.toEqual({ kind: "alias_exists" });

      expect(await aliasRowsOf(tx, t.ghee)).toEqual([
        { alias: t.ghee, canonicalId: t.clarifiedButter, source: "extraction" },
      ]);
    });
  });

  it("refuses an alias that is already an ingredient's name", async () => {
    await inRollback(async (tx) => {
      const t = await fixture(tx);
      const [cauliflower] = await tx
        .select({ name: schema.canonicalIngredient.name })
        .from(schema.canonicalIngredient)
        .where(eq(schema.canonicalIngredient.id, t.cauliflower));
      if (!cauliflower) throw new Error("no cauliflower");

      await expect(
        addAliasAndReresolve(tx, { alias: cauliflower.name, canonicalId: t.clarifiedButter }),
      ).resolves.toEqual({ kind: "alias_exists" });
      expect(await aliasRowsOf(tx, cauliflower.name)).toEqual([]);
    });
  });

  // Intake built its index before the alias landed, so its line was written null under
  // a term that already means clarified butter. Answering "already means something"
  // would leave that draft blocked with nothing on the screen able to clear it.
  it("re-resolves lines held by a term that already means the same ingredient, writing no alias", async () => {
    await inRollback(async (tx) => {
      const t = await fixture(tx);
      await tx
        .insert(schema.ingredientAlias)
        .values({ alias: t.ghee, canonicalId: t.clarifiedButter, source: "hand" });
      const late = await addRecipe(tx, "draft", [{ name: t.ghee, rawText: "2 tbsp ghee" }]);

      await expect(
        addAliasAndReresolve(tx, { alias: t.ghee.toUpperCase(), canonicalId: t.clarifiedButter }),
      ).resolves.toEqual({ kind: "already_known", reresolved: 1 });

      expect(await canonicalIdsOf(tx, late.lineIds)).toEqual([t.clarifiedButter]);
      // Untouched: still one row, still hand-authored.
      expect(await aliasRowsOf(tx, t.ghee)).toEqual([
        { alias: t.ghee, canonicalId: t.clarifiedButter, source: "hand" },
      ]);
      expect(await aliasRowsOf(tx, t.ghee.toUpperCase())).toEqual([]);
    });
  });

  it("re-resolves lines named by an ingredient's own canonical name", async () => {
    await inRollback(async (tx) => {
      const t = await fixture(tx);
      const [row] = await tx
        .select({ name: schema.canonicalIngredient.name })
        .from(schema.canonicalIngredient)
        .where(eq(schema.canonicalIngredient.id, t.clarifiedButter));
      if (!row) throw new Error("no clarified butter");
      const late = await addRecipe(tx, "draft", [{ name: row.name }]);

      await expect(
        addAliasAndReresolve(tx, { alias: row.name, canonicalId: t.clarifiedButter }),
      ).resolves.toEqual({ kind: "already_known", reresolved: 1 });
      expect(await canonicalIdsOf(tx, late.lineIds)).toEqual([t.clarifiedButter]);
      expect(await aliasRowsOf(tx, row.name)).toEqual([]);
    });
  });

  it("leaves every re-resolved recipe a draft, even one it fully resolved", async () => {
    await inRollback(async (tx) => {
      const t = await fixture(tx);
      const onlyGhee = await addRecipe(tx, "draft", [
        { name: "cauliflower", canonicalId: t.cauliflower },
        { name: t.ghee },
      ]);
      const alsoPanko = await addRecipe(tx, "draft", [{ name: t.ghee }, { name: t.panko }]);

      await addAliasAndReresolve(tx, { alias: t.ghee, canonicalId: t.clarifiedButter });

      expect(await statusOf(tx, onlyGhee.recipeId)).toBe("draft");
      expect(await statusOf(tx, alsoPanko.recipeId)).toBe("draft");
    });
  });

  it("never writes to a published recipe's line", async () => {
    await inRollback(async (tx) => {
      const t = await fixture(tx);
      // Unreachable through the publish gate; written directly to prove the update is scoped.
      const published = await addRecipe(tx, "published", [{ name: t.ghee }]);

      await expect(
        addAliasAndReresolve(tx, { alias: t.ghee, canonicalId: t.clarifiedButter }),
      ).resolves.toEqual({ kind: "added", reresolved: 0 });
      expect(await canonicalIdsOf(tx, published.lineIds)).toEqual([null]);
    });
  });

  it("refuses an alias naming an unknown ingredient, and writes nothing", async () => {
    await inRollback(async (tx) => {
      const t = await fixture(tx);
      const draft = await addRecipe(tx, "draft", [{ name: t.ghee }]);

      await expect(
        addAliasAndReresolve(tx, { alias: t.ghee, canonicalId: randomUUID() }),
      ).resolves.toEqual({ kind: "unknown_ingredient" });

      expect(await aliasRowsOf(tx, t.ghee)).toEqual([]);
      expect(await canonicalIdsOf(tx, draft.lineIds)).toEqual([null]);
    });
  });

  it("unblocks a draft that then publishes and leaves a dairy-free search through the tree", async () => {
    await inRollback(async (tx) => {
      const t = await fixture(tx);
      const { recipeId } = await addRecipe(tx, "draft", [
        { name: "cauliflower", canonicalId: t.cauliflower, rawText: "1 cauliflower" },
        { name: t.ghee, rawText: "2 tbsp ghee, melted" },
      ]);

      // Before: the publish gate holds it.
      await expect(publishDraft(tx, recipeId)).resolves.toMatchObject({ kind: "unresolved" });

      await addAliasAndReresolve(tx, { alias: t.ghee, canonicalId: t.clarifiedButter });
      await expect(publishDraft(tx, recipeId)).resolves.toEqual({ kind: "published" });

      // It is a searchable row now, and gone the moment dairy is excluded. Nothing on the
      // recipe says dairy: ghee → clarified butter → butter → dairy does.
      expect((await findCandidateRecipes(tx, [])).map((r) => r.id)).toContain(recipeId);
      expect((await findCandidateRecipes(tx, [t.dairy])).map((r) => r.id)).not.toContain(recipeId);
    });
  });
});
