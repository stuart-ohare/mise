// @gate output
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { IngredientNode } from "./ingredient-tree";
import { outputTerms, scanProse } from "./output-gate";
import { taxonomySchema } from "./taxonomy";

// The scanner's unit tests use a small hand-written tree, which is where its rules are
// pinned. This file is the other half: the phrases a model actually writes, scanned
// against the terms the committed catalogue really produces. A rule that looks right
// against "butter" and "cheese" can still miss "a cheesy crumb" in the shipped data.

const taxonomy = taxonomySchema.parse(
  JSON.parse(readFileSync(resolve(__dirname, "../../scripts/seed/taxonomy.json"), "utf8")),
);
const nodes: IngredientNode[] = taxonomy.nodes.map((n) => ({
  id: n.name,
  name: n.name,
  parentId: n.parent,
  allergenTags: n.allergenTags,
}));
const aliases = taxonomy.nodes.flatMap((n) =>
  n.aliases.map((alias) => ({ canonicalId: n.name, alias })),
);

const termsFor = (excluded: string) => outputTerms(nodes, aliases, [excluded]);

describe("scanning the committed catalogue", () => {
  // The third column is the term the hit must be attributable to. Asserting only that
  // something matched would stay green if stemming broke and a noisier rule replaced it.
  it.each([
    ["dairy", "a cheesy crust", "cheese"],
    ["dairy", "finish with a cheesy crumb", "cheese"],
    ["dairy", "a spoonful of crème fraiche", "crème fraîche"],
    ["dairy", "a spoonful of creme fraiche", "creme fraiche"],
    ["dairy", "A SPOONFUL OF CRÈME FRAÎCHE", "crème fraîche"],
    ["gluten", "creamy oat milk", "oats"],
    ["gluten", "an oatmeal topping", "oats"],
    ["egg", "a spoon of mayo", "mayo"],
    ["gluten", "a dash of Worcester sauce", "worcester sauce"],
  ])("with %s excluded, rejects: %s", (excluded, prose, term) => {
    expect(scanProse(prose, termsFor(excluded)).map((hit) => hit.term)).toContain(term);
  });

  it("leaves a sentence naming nothing excluded alone", () => {
    expect(scanProse("a rich tomato stew", termsFor("dairy"))).toEqual([]);
  });
});
