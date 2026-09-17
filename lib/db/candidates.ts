import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "./client";

/**
 * Gate 2. The candidate set for a Cook request: published recipes containing nothing
 * an exclusion removes. The model only ever ranks and explains these rows.
 */

type Executor = Pick<Db, "execute">;

export const candidateRecipeSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  minutes: z.number().int().nullable(),
  serves: z.number().int().nullable(),
});

export type CandidateRecipe = z.infer<typeof candidateRecipeSchema>;

const idRowSchema = z.object({ id: z.string() });

// Postgres returns uuid text lowercase; compare like with like.
function normalizeIds(ids: readonly string[]): string[] {
  return ids.map((id) => id.toLowerCase());
}

/**
 * The ids the exclusions remove, as a CTE named `exclusion`. It must equal the union
 * of `exclusionIds` in lib/domain/ingredient-tree.ts, which states the rule:
 * - `down` is the subtree of each excluded id, plus the subtree of every node outside
 *   the excluded id's root tree that carries one of that root's tags (soy sauce is
 *   under soy but tagged gluten, so "no wheat flour" must still reach it).
 * - `up` is each excluded id's ancestors as single nodes, because a line resolved to
 *   the generic `egg` may be the egg white someone excluded.
 *
 * UNION rather than UNION ALL on every recursive step, so a cycle in bad data ends.
 * A chain that cycles or dangles has no root, and so, like `exclusionIds`, no widening.
 */
function exclusionCte(excludedIds: readonly string[]): SQL {
  const ids = sql.join(
    excludedIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  return sql`
    WITH RECURSIVE
    excluded(id) AS (SELECT unnest(ARRAY[${ids}]::uuid[])),
    up(id, parent_id) AS (
      SELECT ci.id, ci.parent_id
      FROM canonical_ingredient ci JOIN excluded e ON e.id = ci.id
      UNION
      SELECT ci.id, ci.parent_id
      FROM up JOIN canonical_ingredient ci ON ci.id = up.parent_id
    ),
    root(id, allergen_tags) AS (
      SELECT ci.id, ci.allergen_tags
      FROM up JOIN canonical_ingredient ci ON ci.id = up.id
      WHERE ci.parent_id IS NULL
    ),
    tree(root_id, id) AS (
      SELECT id, id FROM canonical_ingredient WHERE parent_id IS NULL
      UNION
      SELECT tree.root_id, ci.id
      FROM tree JOIN canonical_ingredient ci ON ci.parent_id = tree.id
    ),
    widened(id) AS (
      SELECT ci.id
      FROM root JOIN canonical_ingredient ci ON ci.allergen_tags && root.allergen_tags
      WHERE NOT EXISTS (SELECT 1 FROM tree WHERE tree.root_id = root.id AND tree.id = ci.id)
    ),
    down(id) AS (
      SELECT id FROM excluded
      UNION
      SELECT id FROM widened
      UNION
      SELECT ci.id
      FROM down JOIN canonical_ingredient ci ON ci.parent_id = down.id
    ),
    exclusion(id) AS (SELECT id FROM down UNION SELECT id FROM up)
  `;
}

/**
 * An id gate 1 resolved should exist. If it doesn't, the exclusion set would silently
 * match nothing and every recipe would pass, so fail loudly instead.
 */
async function assertKnownIds(db: Executor, excludedIds: readonly string[]): Promise<void> {
  const ids = sql.join(
    excludedIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await db.execute(
    sql`SELECT id FROM canonical_ingredient WHERE id IN (${ids})`,
  );
  const known = new Set(z.array(idRowSchema).parse(rows).map((row) => row.id));
  const unknown = excludedIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown canonical ingredient id in exclusions: ${unknown.join(", ")}`);
  }
}

/** The exclusion set as SQL computes it. Exported so parity with the domain rule is tested. */
export async function excludedIngredientIds(
  db: Executor,
  rawExcludedIds: readonly string[],
): Promise<Set<string>> {
  const excludedIds = normalizeIds(rawExcludedIds);
  if (excludedIds.length === 0) return new Set();
  await assertKnownIds(db, excludedIds);

  const rows = await db.execute(sql`${exclusionCte(excludedIds)} SELECT id FROM exclusion`);
  return new Set(z.array(idRowSchema).parse(rows).map((row) => row.id));
}

/**
 * Optional ingredients count: optional butter is still butter. An unresolved line
 * (canonical_id IS NULL) blocks its recipe whenever anything is excluded, because an
 * unknown ingredient is exactly where an allergen hides.
 */
export async function findCandidateRecipes(
  db: Executor,
  rawExcludedIds: readonly string[],
): Promise<CandidateRecipe[]> {
  const excludedIds = normalizeIds(rawExcludedIds);
  const columns = sql`r.id, r.title, r.summary, r.minutes, r.serves`;

  if (excludedIds.length === 0) {
    const rows = await db.execute(
      sql`SELECT ${columns} FROM recipe r WHERE r.status = 'published'`,
    );
    return z.array(candidateRecipeSchema).parse(rows);
  }

  await assertKnownIds(db, excludedIds);
  const rows = await db.execute(sql`
    ${exclusionCte(excludedIds)}
    SELECT ${columns}
    FROM recipe r
    WHERE r.status = 'published'
      AND NOT EXISTS (
        SELECT 1 FROM recipe_ingredient ri
        WHERE ri.recipe_id = r.id
          AND (ri.canonical_id IS NULL OR ri.canonical_id IN (SELECT id FROM exclusion))
      )
  `);
  return z.array(candidateRecipeSchema).parse(rows);
}

const ingredientRowSchema = z.object({ recipeId: z.string(), name: z.string() });

/**
 * The ingredient names of rows gate 2 already returned, so call 3 can rank on what the
 * cook says they have. Separate from `findCandidateRecipes` on purpose: gate 2's query
 * is pinned against `exclusionIds` by a parity test, and a join added to it for a
 * non-gate reason is exactly the kind of change that can quietly alter which rows
 * come back.
 */
export async function loadCandidateIngredients(
  db: Executor,
  recipeIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (recipeIds.length === 0) return new Map();
  const ids = sql.join(
    normalizeIds(recipeIds).map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  // The join drops a line whose canonical_id is null. That is only reachable with no
  // exclusions — gate 2 removes such a recipe whenever anything is excluded — so no
  // exclusion promise rests on the omission, and inventing a name from raw_text would
  // hand the model wording the canonical tree never vouched for.
  const rows = await db.execute(sql`
    SELECT ri.recipe_id AS "recipeId", ci.name AS "name"
    FROM recipe_ingredient ri
    JOIN canonical_ingredient ci ON ci.id = ri.canonical_id
    WHERE ri.recipe_id IN (${ids})
    ORDER BY ri.recipe_id, ci.name
  `);

  const byRecipe = new Map<string, string[]>();
  for (const row of z.array(ingredientRowSchema).parse(rows)) {
    const names = byRecipe.get(row.recipeId);
    if (names) names.push(row.name);
    else byRecipe.set(row.recipeId, [row.name]);
  }
  return byRecipe;
}
