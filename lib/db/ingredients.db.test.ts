import { randomUUID } from "node:crypto";

import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { exclusionIds } from "@/lib/domain/ingredient-tree";
import { outputTerms } from "@/lib/domain/output-gate";

import { loadIngredientTree } from "./ingredients";
import * as schema from "./schema";
import { loadResolutionTerms } from "./terms";

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

type Fixture = { sfx: string; dairy: string; butter: string; ghee: string };

/** dairy → butter → ghee, so the assertions need a parent two levels up to be present. */
async function buildFixture(tx: Tx): Promise<Fixture> {
  const sfx = randomUUID().slice(0, 8);

  async function node(
    name: string,
    parentId: string | null,
    allergenTags: string[],
    aliases: string[],
  ): Promise<string> {
    const [row] = await tx
      .insert(schema.canonicalIngredient)
      .values({ name, parentId, allergenTags })
      .returning({ id: schema.canonicalIngredient.id });
    if (!row) throw new Error(`insert of "${name}" returned no row`);
    if (aliases.length > 0) {
      await tx
        .insert(schema.ingredientAlias)
        .values(aliases.map((alias) => ({ alias, canonicalId: row.id })));
    }
    return row.id;
  }

  const dairy = await node(`dairy ${sfx}`, null, [`dairy ${sfx}`], []);
  const butter = await node(`butter ${sfx}`, dairy, [], [`sweet cream butter ${sfx}`]);
  const ghee = await node(`ghee ${sfx}`, butter, [], [`clarified butter ${sfx}`]);

  return { sfx, dairy, butter, ghee };
}

describe("loadIngredientTree", () => {
  it("returns each node's parent so the tree can be walked", async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const { nodes } = await loadIngredientTree(tx);
      const byId = new Map(nodes.map((node) => [node.id, node]));

      expect(byId.get(f.dairy)?.parentId).toBeNull();
      expect(byId.get(f.butter)?.parentId).toBe(f.dairy);
      expect(byId.get(f.ghee)?.parentId).toBe(f.butter);
    });
  });

  it("returns each node's allergen tags", async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const { nodes } = await loadIngredientTree(tx);
      const byId = new Map(nodes.map((node) => [node.id, node]));

      expect(byId.get(f.dairy)?.allergenTags).toEqual([`dairy ${f.sfx}`]);
      expect(byId.get(f.butter)?.allergenTags).toEqual([]);
    });
  });

  it("returns every alias against its own ingredient", async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const { aliases } = await loadIngredientTree(tx);

      expect(aliases).toContainEqual({
        canonicalId: f.butter,
        alias: `sweet cream butter ${f.sfx}`,
      });
      expect(aliases).toContainEqual({
        canonicalId: f.ghee,
        alias: `clarified butter ${f.sfx}`,
      });
    });
  });

  it("feeds exclusionIds so a parent exclusion reaches the whole subtree", async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const { nodes } = await loadIngredientTree(tx);

      // The tree is what makes this true: on a flat node list, ghee is unreachable.
      expect(exclusionIds(nodes, f.dairy)).toContain(f.ghee);
    });
  });

  it("feeds outputTerms so gate 3 scans for a descendant's alias", async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const { nodes, aliases } = await loadIngredientTree(tx);

      const terms = outputTerms(nodes, aliases, [f.dairy]);

      expect(terms).toContain(`ghee ${f.sfx}`);
      expect(terms).toContain(`clarified butter ${f.sfx}`);
    });
  });

  it("agrees with loadResolutionTerms about what every term is", async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const [{ nodes, aliases }, terms] = await Promise.all([
        loadIngredientTree(tx),
        loadResolutionTerms(tx),
      ]);

      const ours = new Set([f.dairy, f.butter, f.ghee]);
      const fromTree = [
        ...nodes.filter((n) => ours.has(n.id)).map((n) => n.name),
        ...aliases.filter((a) => ours.has(a.canonicalId)).map((a) => a.alias),
      ].sort();
      const fromTerms = terms
        .filter((t) => ours.has(t.canonicalId))
        .map((t) => t.term)
        .sort();

      // Gate 1 matches on one of these lists and gate 3 scans the other. A divergence
      // would mean prose could name a food the query filtered, or the reverse.
      expect(fromTree).toEqual(fromTerms);
    });
  });

  it("leaves the database as it found it", async () => {
    let sfx = "";
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      sfx = f.sfx;

      const { nodes } = await loadIngredientTree(tx);
      expect(nodes.map((n) => n.name)).toContain(`ghee ${f.sfx}`);
    });

    const { nodes } = await loadIngredientTree(db);
    expect(nodes.map((n) => n.name)).not.toContain(`ghee ${sfx}`);
  });
});
