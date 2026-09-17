import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DELIBERATELY_UNRESOLVED,
  leavesSchema,
  recipesSchema,
} from "@/lib/ai/prompts/seed-catalogue";
import { effectiveAllergenTags, subtreeIds, type IngredientNode } from "@/lib/domain/ingredient-tree";
import { buildNameIndex, deriveRecipeStatus, resolveTerm } from "@/lib/domain/resolution";
import { taxonomySchema, validateTaxonomy } from "@/lib/domain/taxonomy";

// The committed catalogue is generated, so its properties are pinned against the files
// themselves: what the model was asked for is only a request until this passes.

const read = (file: string): unknown => {
  const path = resolve(__dirname, file);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};

const taxonomy = taxonomySchema.parse(read("taxonomy.json"));
const leavesParse = leavesSchema.safeParse(read("leaves.json"));
const recipesParse = recipesSchema.safeParse(read("recipes.json"));
const leaves = leavesParse.success ? leavesParse.data.nodes : [];
const recipes = recipesParse.success ? recipesParse.data.recipes : [];

const allNodes = [...taxonomy.nodes, ...leaves];
const tree: IngredientNode[] = allNodes.map((n) => ({
  id: n.name,
  name: n.name,
  parentId: n.parent,
  allergenTags: n.allergenTags,
}));
const index = buildNameIndex(allNodes.flatMap((n) => [n.name, ...n.aliases].map((term) => ({ term, id: n.name }))));

const handTerms = taxonomy.nodes.flatMap((n) => [n.name, ...n.aliases]);
const dairyTerms = taxonomy.nodes
  .filter((n) => subtreeIds(tree, "dairy").has(n.name))
  .flatMap((n) => [n.name, ...n.aliases]);

const containsWord = (text: string, word: string) =>
  new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu").test(text);

/**
 * Leaves whose name contains a hand-authored term, each checked by hand. A leaf can't
 * carry an allergen tag, so a compound like "peanut butter" filed under one root would
 * silently miss its second allergen. Every such name has to be on this list, with the
 * reason it is safe, before the catalogue passes.
 */
const REVIEWED_COMPOUND_LEAVES: Record<string, string> = {};

const statusOf = (recipe: (typeof recipes)[number]) =>
  deriveRecipeStatus(
    recipe.ingredients.map((i) => ({ canonicalId: resolveTerm(i.name, index), optional: i.optional })),
  );

describe("scripts/seed/leaves.json", () => {
  it("is committed and matches its schema", () => {
    expect(leavesParse.error?.issues ?? []).toEqual([]);
    expect(leavesParse.success).toBe(true);
  });

  it("validates as one tree with the hand-authored taxonomy", () => {
    const result = validateTaxonomy({ nodes: allNodes });
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("gives every generated leaf empty allergenTags", () => {
    expect(leaves.length).toBeGreaterThan(0);
    for (const leaf of leaves) expect(leaf.allergenTags, leaf.name).toEqual([]);
  });

  it("puts every leaf whose name contains a hand-authored term on the reviewed list", () => {
    const unreviewed = leaves
      .filter((leaf) => handTerms.some((term) => containsWord(leaf.name, term)))
      .map((leaf) => leaf.name)
      .filter((name) => !(name in REVIEWED_COMPOUND_LEAVES));
    expect(unreviewed).toEqual([]);
  });
});

describe("scripts/seed/recipes.json", () => {
  it("is committed and matches its schema", () => {
    expect(recipesParse.error?.issues ?? []).toEqual([]);
    expect(recipesParse.success).toBe(true);
  });

  it("has about 60 recipes", () => {
    expect(recipes.length).toBeGreaterThanOrEqual(55);
    expect(recipes.length).toBeLessThanOrEqual(65);
  });

  it("has a recipe whose only dairy is optional butter, under an innocent title", () => {
    const cases = recipes.filter((r) => r.adversarialCase === "optional-butter");
    expect(cases).toHaveLength(1);
    const [recipe] = cases;
    if (!recipe) return;

    const dairy = recipe.ingredients.filter((i) => {
      const id = resolveTerm(i.name, index);
      return id !== null && effectiveAllergenTags(tree, id).has("dairy");
    });
    expect(dairy.length).toBeGreaterThan(0);
    for (const i of dairy) expect(i.optional, i.rawText).toBe(true);
    expect(dairy.some((i) => subtreeIds(tree, "butter").has(resolveTerm(i.name, index) ?? ""))).toBe(true);

    for (const term of dairyTerms) expect(containsWord(recipe.title, term), term).toBe(false);

    // Gate 2 and 3 fixtures need it searchable, so it must not be stuck in draft.
    expect(statusOf(recipe)).toBe("published");
  });

  it("has a near-duplicate that points at a different recipe", () => {
    const cases = recipes.filter((r) => r.adversarialCase === "near-duplicate");
    expect(cases.length).toBeGreaterThan(0);
    for (const recipe of cases) {
      const original = recipes.find((r) => r.title === recipe.duplicateOf);
      expect(original, recipe.title).toBeDefined();
      expect(original?.title).not.toBe(recipe.title);
      const originalNames = new Set(original?.ingredients.map((i) => i.name));
      expect(recipe.ingredients.some((i) => !originalNames.has(i.name)), recipe.title).toBe(true);
    }
  });

  it.each(DELIBERATELY_UNRESOLVED)("uses %s in a recipe, and in no name or alias", (term) => {
    expect(recipes.some((r) => r.ingredients.some((i) => i.name === term))).toBe(true);
    expect(resolveTerm(term, index)).toBeNull();
  });

  it("has at least 3 drafts, each held only by a deliberately unresolved term", () => {
    const drafts = recipes.filter((r) => statusOf(r) === "draft");
    expect(drafts.length).toBeGreaterThanOrEqual(3);

    const unresolved = recipes.flatMap((r) =>
      r.ingredients.filter((i) => resolveTerm(i.name, index) === null).map((i) => i.name),
    );
    const allowed: readonly string[] = DELIBERATELY_UNRESOLVED;
    expect([...new Set(unresolved.filter((name) => !allowed.includes(name)))]).toEqual([]);
  });

  it("gives every ingredient non-empty raw text", () => {
    for (const r of recipes) for (const i of r.ingredients) expect(i.rawText.trim(), r.title).not.toBe("");
  });
});
