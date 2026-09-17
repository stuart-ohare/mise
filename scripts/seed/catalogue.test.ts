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

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const containsWord = (text: string, word: string) =>
  new RegExp(`(^|[^\\p{L}])${escape(word)}($|[^\\p{L}])`, "iu").test(text);

/**
 * Leaves whose name contains a hand-authored term, each checked by hand. A leaf can't
 * carry an allergen tag, so a compound like "peanut butter" filed under one root would
 * silently miss its second allergen. Every such name has to be on this list, with the
 * reason it is safe, before the catalogue passes.
 */
const REVIEWED_COMPOUND_LEAVES: Record<string, string> = {
  "coconut milk": "a plant milk, not dairy",
  "almond flour": "ground almonds only; under almond, so nuts",
  "smooth peanut butter": "peanuts and oil; under peanut, so nuts",
  "squid ink": "under squid, so shellfish",
  "crusty bread": "under bread, so gluten; bread's possible milk is the taxonomy's decision",
  "dark chocolate chips": "under dark chocolate, so dairy and soy",
};

/** Where each deliberately unresolved term would resolve once review adds its alias. */
const INTENDED_NODE: Record<string, string> = {
  ghee: "clarified butter",
  panko: "japanese breadcrumbs",
  brinjal: "aubergine",
};

/** Prose that contains an allergen word without meaning that ingredient, checked by hand. */
const REVIEWED_PROSE_PHRASES: Record<string, string> = {
  "peanut butter": "the smooth peanut butter ingredient, not dairy butter",
  "resembles breadcrumbs": "a crumble's texture, not an ingredient",
  "pasta water": "the pan's cooking water, not an ingredient",
};

const byName = new Map(allNodes.map((n) => [n.name, n]));
const chain = (name: string | null) => {
  const names: string[] = [];
  for (let n = name; n; n = byName.get(n)?.parent ?? null) names.push(n);
  return names;
};
const handNames = new Set(taxonomy.nodes.map((n) => n.name));
/** Nodes that are, or hang under, a hand-authored node: where an allergen can be. */
const scanned = allNodes.filter((n) => chain(n.name).some((c) => handNames.has(c)));
const safeNames = allNodes.filter((n) => !scanned.includes(n)).map((n) => n.name);
const termsOf = (names: Iterable<string>) =>
  [...names].flatMap((name) => [name, ...(byName.get(name)?.aliases ?? [])]);

/**
 * The allergen-bearing terms in `text` that `carried` doesn't account for. Carried terms,
 * safe leaf names and reviewed phrases are removed first, longest first, so "egg pasta"
 * is gone before "egg" is looked for and "coconut milk" isn't read as milk.
 */
function uncarriedTerms(text: string, carried: ReadonlySet<string>): string[] {
  const remaining = [...Object.keys(REVIEWED_PROSE_PHRASES), ...termsOf(carried), ...safeNames]
    .sort((a, b) => b.length - a.length)
    .reduce(
      (t, term) => t.replace(new RegExp(`(^|[^\\p{L}])${escape(term)}(?=$|[^\\p{L}])`, "gu"), "$1 "),
      text.toLowerCase(),
    );
  return scanned
    .filter((node) => !carried.has(node.name))
    .flatMap((node) => termsOf([node.name]))
    .filter((term) => containsWord(remaining, term));
}

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

  it("names each deliberately unresolved term in the raw text it came from", () => {
    // Seeding resolves `name`, not the line. A "ghee" line named "olive oil" would publish.
    const unresolved: readonly string[] = DELIBERATELY_UNRESOLVED;
    for (const r of recipes) {
      for (const i of r.ingredients) {
        for (const term of unresolved) {
          expect(containsWord(i.rawText, term), `${r.title}: "${i.rawText}" named ${i.name}`).toBe(
            i.name === term,
          );
        }
      }
    }
  });

  it("gives every resolved ingredient a name its raw text supports", () => {
    // The name, one of its node's aliases, or the name's head noun ("pepper, to taste" is
    // black pepper) must appear in the line, so a model can't file a line under the
    // wrong ingredient without it showing.
    const mismatched: string[] = [];
    for (const r of recipes) {
      for (const i of r.ingredients) {
        const id = resolveTerm(i.name, index);
        if (id === null) continue;
        const node = allNodes.find((n) => n.name === id);
        const head = i.name.split(" ").at(-1) ?? i.name;
        // "leaf" in "curry leaves", "berry" in "blackberries".
        const words = [i.name, ...(node?.aliases ?? []), head, head.replace(/(f|y)$/, "")];
        if (!words.some((w) => i.rawText.toLowerCase().includes(w))) {
          mismatched.push(`${r.title}: "${i.rawText}" named ${i.name}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("mentions no allergen-bearing ingredient in its prose that its ingredients don't carry", () => {
    // Gate 2 filters on resolved ingredient rows and never reads the prose. "Serve with
    // crusty bread" in a recipe with no bread passes a gluten-free search and then tells
    // the reader to eat bread.
    const found: string[] = [];
    for (const r of recipes) {
      const carried = new Set(
        r.ingredients.flatMap((i) => chain(resolveTerm(i.name, index) ?? INTENDED_NODE[i.name] ?? null)),
      );
      const prose = [r.title, r.summary, ...r.steps].join("\n");
      for (const term of uncarriedTerms(prose, carried)) found.push(`${r.title}: "${term}"`);
    }
    expect(found).toEqual([]);
  });

  it("carries every allergen-bearing word in an ingredient line through that line's own name", () => {
    // Seeding resolves `name`, not the line: "1 tbsp butter or olive oil" named olive oil
    // would publish with no dairy row.
    const found: string[] = [];
    for (const r of recipes) {
      for (const i of r.ingredients) {
        const carried = new Set(chain(resolveTerm(i.name, index) ?? INTENDED_NODE[i.name] ?? null));
        for (const term of uncarriedTerms(i.rawText, carried)) {
          found.push(`${r.title}: "${i.rawText}" named ${i.name} has "${term}"`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

const docLines = (file: string) => readFileSync(resolve(__dirname, "../..", file), "utf8").split("\n");

/** The README's gate 2 row — the one sentence a reviewer is most likely to read. */
const readmeGate2 = docLines("README.md").find((line) => line.trimStart().startsWith("| 2 — Query |")) ?? "";

/** ADR 0002's numbered item 2: the same claim, in the document that defends it. */
const adrGate2 = (() => {
  const lines = docLines("docs/decisions/0002-exclusion-is-a-database-constraint.md");
  const start = lines.findIndex((line) => line.startsWith("2. SQL produces the candidate set"));
  if (start < 0) return "";
  const end = lines.findIndex((line, i) => i > start && !line.startsWith("   "));
  return lines.slice(start, end < 0 ? undefined : end).join(" ");
})();

/**
 * The row says "dairy-free search", so the root's own terms can't be what it
 * demonstrates — the claim is that the query reaches a *descendant*. Aliases included,
 * so giving `dairy` one later can't quietly satisfy the assertion.
 */
const dairyRootTerms = new Set(termsOf(["dairy"]));
const dairyDescendants = dairyTerms.filter((term) => !dairyRootTerms.has(term));

// A claim about this catalogue is pinned against this catalogue, like every other
// property here. Both documents explained the tree with a term the catalogue is
// generated never to know, so both described a lookup that doesn't happen — and a
// reader who tried the worked example got the opposite of what it promised.
describe.each([
  ["README's gate 2 row", readmeGate2],
  ["ADR 0002's gate 2 claim", adrGate2],
])("%s", (_where, claim) => {
  it("is still where the test looks for it", () => {
    expect(claim).not.toBe("");
  });

  it("names no term the catalogue deliberately can't resolve", () => {
    expect(DELIBERATELY_UNRESOLVED.filter((term) => containsWord(claim, term))).toEqual([]);
  });

  it("explains the filter with a dairy descendant", () => {
    expect(dairyDescendants.filter((term) => containsWord(claim, term))).not.toEqual([]);
  });
});

describe("README's gate 2 row", () => {
  it("names a published recipe that actually contains one", () => {
    // The row names a dish by title so a reviewer can type it into the Cook box. Checking
    // only the ingredient would leave the title free to drift when the catalogue is
    // regenerated: twelve published recipes contain butter, so the word would still be
    // there while the dish the README promises had gone.
    const named = dairyDescendants.filter((term) => containsWord(readmeGate2, term));
    const demonstrated = recipes.filter(
      (r) =>
        statusOf(r) === "published" &&
        readmeGate2.toLowerCase().includes(r.title.toLowerCase()) &&
        r.ingredients.some((i) => named.includes(i.name)),
    );
    expect(demonstrated.map((r) => r.title)).not.toEqual([]);
  });
});
