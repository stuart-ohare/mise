import { randomUUID } from "node:crypto";

import { eq, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { buildResolutionIndex, resolveExclusions } from "@/lib/domain/resolve-exclusions";

import * as schema from "./schema";
import { loadResolutionTerms, type ResolutionTerm } from "./terms";

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

type Fixture = {
  sfx: string;
  wheat: string;
  butter: string;
  dairy: string;
  ids: Set<string>;
};

/**
 * `dairy` claims the alias "Butter <sfx>" while another node is named "butter <sfx>".
 * Both unique indexes are case-sensitive so the rows coexist, but gate 1 normalises the
 * case away and the term is claimed twice — the collision #41 will make impossible.
 */
async function buildFixture(tx: Tx): Promise<Fixture> {
  // canonical_ingredient.name is unique and the database may already hold the seed.
  const sfx = randomUUID().slice(0, 8);

  async function node(name: string, aliases: string[]): Promise<string> {
    const [row] = await tx
      .insert(schema.canonicalIngredient)
      .values({ name })
      .returning({ id: schema.canonicalIngredient.id });
    if (!row) throw new Error(`insert of "${name}" returned no row`);
    if (aliases.length > 0) {
      await tx
        .insert(schema.ingredientAlias)
        .values(aliases.map((alias) => ({ alias, canonicalId: row.id })));
    }
    return row.id;
  }

  const wheat = await node(`wheat ${sfx}`, [`flour ${sfx}`, `plain flour ${sfx}`]);
  const butter = await node(`butter ${sfx}`, []);
  const dairy = await node(`dairy ${sfx}`, [`Butter ${sfx}`]);

  return { sfx, wheat, butter, dairy, ids: new Set([wheat, butter, dairy]) };
}

/** The loader returns every row in the database, so assert only on the fixture's own. */
function mine(terms: ResolutionTerm[], fixture: Fixture): ResolutionTerm[] {
  return terms.filter((t) => fixture.ids.has(t.canonicalId));
}

describe("loadResolutionTerms", () => {
  it("returns a canonical name carrying its own ingredient's id", async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const terms = mine(await loadResolutionTerms(tx), f);

      expect(terms).toContainEqual({ term: `wheat ${f.sfx}`, canonicalId: f.wheat });
    });
  });

  it("returns every alias carrying the same id as its ingredient's name", async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const terms = mine(await loadResolutionTerms(tx), f);

      expect(terms).toContainEqual({ term: `flour ${f.sfx}`, canonicalId: f.wheat });
      expect(terms).toContainEqual({ term: `plain flour ${f.sfx}`, canonicalId: f.wheat });
    });
  });

  it("returns names and aliases as one flat list", async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const terms = mine(await loadResolutionTerms(tx), f);

      // 3 names + 3 aliases: nothing nested, separated or deduped.
      expect(terms).toHaveLength(6);
      expect(terms.map((t) => t.term).sort()).toEqual(
        [
          `Butter ${f.sfx}`,
          `butter ${f.sfx}`,
          `dairy ${f.sfx}`,
          `flour ${f.sfx}`,
          `plain flour ${f.sfx}`,
          `wheat ${f.sfx}`,
        ].sort(),
      );
    });
  });

  it("feeds buildResolutionIndex so gate 1 resolves an alias the user typed loosely", async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const index = buildResolutionIndex(await loadResolutionTerms(tx));

      const [result] = resolveExclusions([`  PLAIN   FLOUR ${f.sfx}  `], index);

      expect(result).toEqual({
        kind: "resolved",
        term: `  PLAIN   FLOUR ${f.sfx}  `,
        canonicalId: f.wheat,
      });
    });
  });

  it("leaves a term two ingredients claim unresolved rather than binding it to one", async () => {
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      const index = buildResolutionIndex(await loadResolutionTerms(tx));

      const [result] = resolveExclusions([`butter ${f.sfx}`], index);

      // Neither the butter node nor dairy: the safe answer is to ask the user.
      expect(result).toEqual({ kind: "unresolved", term: `butter ${f.sfx}` });
    });
  });

  it("leaves the database as it found it", async () => {
    let sfx = "";
    await inRollback(async (tx) => {
      const f = await buildFixture(tx);
      sfx = f.sfx;
    });

    const rows = await db
      .select({ id: schema.canonicalIngredient.id })
      .from(schema.canonicalIngredient)
      .where(eq(schema.canonicalIngredient.name, `wheat ${sfx}`));

    expect(rows).toEqual([]);
  });
});
