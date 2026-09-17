// @gate query
import { randomUUID } from "node:crypto";

import { eq, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { exclusionIds, type IngredientNode } from "@/lib/domain/ingredient-tree";

import {
  excludedIngredientIds,
  findCandidateRecipes,
  loadCandidateIngredients,
  type CandidateRecipe,
} from "./candidates";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. pnpm test:db needs docker compose up -d, pnpm db:push and .env.local.",
  );
}

const client = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

// Same shapes as the committed taxonomy, including a node with a second allergen as
// its own tag (soy sauce, under soy, tagged gluten).
const TREE = [
  ["dairy", null, ["dairy"]],
  ["butter", "dairy", []],
  ["clarified butter", "butter", []],
  ["gluten", null, ["gluten"]],
  ["wheat flour", "gluten", []],
  ["pasta", "gluten", []],
  ["soy", null, ["soy"]],
  ["tofu", "soy", []],
  ["soy sauce", "soy", ["gluten"]],
  ["tamari", "soy sauce", []],
  ["egg", null, ["egg"]],
  ["egg white", "egg", []],
  ["veg", null, []],
  ["cauliflower", "veg", []],
] as const;

type Name = (typeof TREE)[number][0];
type Tree = Record<Name, string>;

async function buildTree(tx: Tx): Promise<Tree> {
  // canonical_ingredient.name is unique and the database may already hold the seed.
  const suffix = randomUUID().slice(0, 8);
  const ids: Partial<Record<Name, string>> = {};
  for (const [name, parent, tags] of TREE) {
    const [row] = await tx
      .insert(schema.canonicalIngredient)
      .values({
        name: `${name} ${suffix}`,
        parentId: parent === null ? null : ids[parent],
        allergenTags: [...tags],
      })
      .returning({ id: schema.canonicalIngredient.id });
    ids[name] = row.id;
  }
  return ids as Tree;
}

type Line = { id: string | null; optional?: boolean };

async function addRecipe(
  tx: Tx,
  status: "draft" | "published",
  lines: Line[],
): Promise<string> {
  const [row] = await tx
    .insert(schema.recipe)
    .values({ title: `fixture ${randomUUID()}`, status })
    .returning({ id: schema.recipe.id });
  await tx.insert(schema.recipeIngredient).values(
    lines.map((line) => ({
      recipeId: row.id,
      canonicalId: line.id,
      rawText: "fixture line",
      optional: line.optional ?? false,
    })),
  );
  return row.id;
}

async function allNodes(tx: Tx): Promise<IngredientNode[]> {
  const rows = await tx.select().from(schema.canonicalIngredient);
  return rows.map(({ id, name, parentId, allergenTags }) => ({ id, name, parentId, allergenTags }));
}

function idsOf(recipes: CandidateRecipe[]): Set<string> {
  return new Set(recipes.map((r) => r.id));
}

describe("findCandidateRecipes", () => {
  it("drops a recipe whose only dairy is a grandchild of dairy", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const clarified = await addRecipe(tx, "published", [{ id: t.cauliflower }, { id: t["clarified butter"] }]);
      const control = await addRecipe(tx, "published", [{ id: t.cauliflower }]);

      const found = idsOf(await findCandidateRecipes(tx, [t.dairy]));
      expect(found.has(control)).toBe(true);
      expect(found.has(clarified)).toBe(false);
    });
  });

  it("drops a recipe whose only dairy is optional", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const optionalButter = await addRecipe(tx, "published", [
        { id: t.cauliflower },
        { id: t.butter, optional: true },
      ]);
      const control = await addRecipe(tx, "published", [{ id: t.cauliflower }]);

      const found = idsOf(await findCandidateRecipes(tx, [t.dairy]));
      expect(found.has(control)).toBe(true);
      expect(found.has(optionalButter)).toBe(false);
    });
  });

  it("returns a dairy-free published recipe and not a dairy-free draft", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const published = await addRecipe(tx, "published", [{ id: t.cauliflower }]);
      const draft = await addRecipe(tx, "draft", [{ id: t.cauliflower }]);

      const found = idsOf(await findCandidateRecipes(tx, [t.dairy]));
      expect(found.has(published)).toBe(true);
      expect(found.has(draft)).toBe(false);
    });
  });

  it("composes two exclusions: a recipe hit by either is dropped", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const butter = await addRecipe(tx, "published", [{ id: t.cauliflower }, { id: t.butter }]);
      const eggWhite = await addRecipe(tx, "published", [{ id: t.cauliflower }, { id: t["egg white"] }]);
      const control = await addRecipe(tx, "published", [{ id: t.cauliflower }]);

      const found = idsOf(await findCandidateRecipes(tx, [t.dairy, t.egg]));
      expect(found.has(control)).toBe(true);
      expect(found.has(butter)).toBe(false);
      expect(found.has(eggWhite)).toBe(false);
    });
  });

  it("fails closed on an unresolved ingredient when any exclusion is present", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const unresolved = await addRecipe(tx, "published", [{ id: t.cauliflower }, { id: null }]);
      const control = await addRecipe(tx, "published", [{ id: t.cauliflower }]);

      const excluding = idsOf(await findCandidateRecipes(tx, [t.dairy]));
      expect(excluding.has(control)).toBe(true);
      expect(excluding.has(unresolved)).toBe(false);

      // The spec scopes fail-closed to "when any exclusion is present".
      const unfiltered = idsOf(await findCandidateRecipes(tx, []));
      expect(unfiltered.has(unresolved)).toBe(true);
    });
  });

  it("drops a recipe whose only gluten is soy sauce from a gluten-free and a no-wheat-flour query", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const soySauce = await addRecipe(tx, "published", [{ id: t.tofu }, { id: t["soy sauce"] }]);
      const control = await addRecipe(tx, "published", [{ id: t.cauliflower }]);

      for (const excluded of [t.gluten, t["wheat flour"]]) {
        const found = idsOf(await findCandidateRecipes(tx, [excluded]));
        expect(found.has(control)).toBe(true);
        expect(found.has(soySauce)).toBe(false);
      }
    });
  });

  it("drops a recipe with generic egg from a no-egg-white query", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const eggs = await addRecipe(tx, "published", [{ id: t.cauliflower }, { id: t.egg }]);
      const control = await addRecipe(tx, "published", [{ id: t.cauliflower }]);

      const found = idsOf(await findCandidateRecipes(tx, [t["egg white"]]));
      expect(found.has(control)).toBe(true);
      expect(found.has(eggs)).toBe(false);
    });
  });

  it("does not widen by the excluded node's own extra tag", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const tofu = await addRecipe(tx, "published", [{ id: t.tofu }]);
      const pasta = await addRecipe(tx, "published", [{ id: t.pasta }]);

      const found = idsOf(await findCandidateRecipes(tx, [t["soy sauce"]]));
      expect(found.has(tofu)).toBe(true);
      expect(found.has(pasta)).toBe(true);
    });
  });

  it("rejects an excluded id that is not a canonical ingredient", async () => {
    await inRollback(async (tx) => {
      await buildTree(tx);
      await expect(findCandidateRecipes(tx, [randomUUID()])).rejects.toThrow(/unknown/i);
    });
  });

  it("accepts an excluded id in uppercase, which is still a valid UUID", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const butter = await addRecipe(tx, "published", [{ id: t.cauliflower }, { id: t.butter }]);
      const control = await addRecipe(tx, "published", [{ id: t.cauliflower }]);

      const found = idsOf(await findCandidateRecipes(tx, [t.dairy.toUpperCase()]));
      expect(found.has(control)).toBe(true);
      expect(found.has(butter)).toBe(false);
    });
  });
});

describe("excludedIngredientIds", () => {
  it("equals exclusionIds for every node of a tree with a two-allergen node", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      // Every node in the database, so seed rows that share a tag are compared too.
      const nodes = await allNodes(tx);

      for (const [name] of TREE) {
        const sql = await excludedIngredientIds(tx, [t[name]]);
        expect({ name, ids: sql }).toEqual({ name, ids: exclusionIds(nodes, t[name]) });
      }
    });
  });

  it("equals the union of exclusionIds for several exclusions", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const nodes = await allNodes(tx);

      const expected = new Set([...exclusionIds(nodes, t.dairy), ...exclusionIds(nodes, t.egg)]);
      expect(await excludedIngredientIds(tx, [t.dairy, t.egg])).toEqual(expected);
    });
  });

  it("equals exclusionIds for a cyclic chain and a dangling parent", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const suffix = randomUUID().slice(0, 8);
      const insert = async (name: string, parentId: string | null, tags: string[]) => {
        const [row] = await tx
          .insert(schema.canonicalIngredient)
          .values({ name: `${name} ${suffix}`, parentId, allergenTags: tags })
          .returning({ id: schema.canonicalIngredient.id });
        return row.id;
      };

      // parent_id has no foreign key, so bad seed data can hold both shapes. Each is
      // tagged gluten, so a gluten exclusion must widen into it: it sits in no root's tree.
      const loopA = await insert("loop a", null, ["gluten"]);
      const loopB = await insert("loop b", loopA, []);
      const loopChild = await insert("loop child", loopB, []);
      await tx
        .update(schema.canonicalIngredient)
        .set({ parentId: loopB })
        .where(eq(schema.canonicalIngredient.id, loopA));
      const orphan = await insert("orphan", randomUUID(), ["gluten"]);
      const orphanChild = await insert("orphan child", orphan, []);

      const nodes = await allNodes(tx);
      for (const id of [t.gluten, loopA, loopB, loopChild, orphan, orphanChild]) {
        expect(await excludedIngredientIds(tx, [id])).toEqual(exclusionIds(nodes, id));
      }
      // The widening itself, not just agreement: gluten reaches both bad chains.
      const gluten = await excludedIngredientIds(tx, [t.gluten]);
      for (const id of [loopA, loopB, loopChild, orphan, orphanChild]) {
        expect(gluten.has(id)).toBe(true);
      }
    });
  });

  it("rejects an excluded id that is not a canonical ingredient", async () => {
    await inRollback(async (tx) => {
      await buildTree(tx);
      await expect(excludedIngredientIds(tx, [randomUUID()])).rejects.toThrow(/unknown/i);
    });
  });

  it("treats an uppercase excluded id as the same ingredient", async () => {
    await inRollback(async (tx) => {
      const t = await buildTree(tx);
      const nodes = await allNodes(tx);

      expect(await excludedIngredientIds(tx, [t["soy sauce"].toUpperCase()])).toEqual(
        exclusionIds(nodes, t["soy sauce"]),
      );
    });
  });
});

describe("loadCandidateIngredients", () => {
  it("returns every resolved ingredient name of a recipe, grouped by recipe", async () => {
    await inRollback(async (tx) => {
      const tree = await buildTree(tx);
      const stew = await addRecipe(tx, "published", [
        { id: tree.cauliflower },
        { id: tree.butter },
        { id: tree["wheat flour"] },
      ]);
      const plain = await addRecipe(tx, "published", [{ id: tree.cauliflower }]);

      const byRecipe = await loadCandidateIngredients(tx, [stew, plain]);

      // A recipe has many ingredient rows: the grouping is the whole job here.
      expect(byRecipe.get(stew)?.length).toBe(3);
      expect(byRecipe.get(plain)?.length).toBe(1);
    });
  });

  it("names the ingredients by their canonical name", async () => {
    await inRollback(async (tx) => {
      const tree = await buildTree(tx);
      const id = await addRecipe(tx, "published", [{ id: tree.butter }]);

      const names = await loadCandidateIngredients(tx, [id]);

      expect(names.get(id)?.[0]).toMatch(/^butter /);
    });
  });

  it("asks for nothing when there are no candidate rows", async () => {
    await inRollback(async (tx) => {
      expect(await loadCandidateIngredients(tx, [])).toEqual(new Map());
    });
  });

  it("omits an unresolved line rather than inventing a name for it", async () => {
    await inRollback(async (tx) => {
      const tree = await buildTree(tx);
      // Only reachable with no exclusions: gate 2 removes such a recipe otherwise, so
      // no exclusion promise rests on the omission.
      const id = await addRecipe(tx, "published", [{ id: tree.cauliflower }, { id: null }]);

      const byRecipe = await loadCandidateIngredients(tx, [id]);

      expect(byRecipe.get(id)?.length).toBe(1);
    });
  });

  it("returns nothing for a recipe id that isn't asked about", async () => {
    await inRollback(async (tx) => {
      const tree = await buildTree(tx);
      const asked = await addRecipe(tx, "published", [{ id: tree.butter }]);
      const other = await addRecipe(tx, "published", [{ id: tree["wheat flour"] }]);

      const byRecipe = await loadCandidateIngredients(tx, [asked]);

      expect(byRecipe.has(other)).toBe(false);
    });
  });
});
