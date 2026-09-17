// @gate query
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { effectiveAllergenTags, exclusionIds, type IngredientNode } from "@/lib/domain/ingredient-tree";
import { buildResolutionIndex, resolveExclusions } from "@/lib/domain/resolve-exclusions";
import { ALLERGENS, taxonomySchema, validateTaxonomy } from "@/lib/domain/taxonomy";

// The committed allergen tree is the data gate 2 walks. A wrong parent here leaks a
// recipe through a dairy-free search however correct the SQL is, so its safety
// properties are pinned against the file itself.

const taxonomy = taxonomySchema.parse(
  JSON.parse(readFileSync(resolve(__dirname, "taxonomy.json"), "utf8")),
);
const nodes: IngredientNode[] = taxonomy.nodes.map((n) => ({
  id: n.name,
  name: n.name,
  parentId: n.parent,
  allergenTags: n.allergenTags,
}));
const terms = new Set(taxonomy.nodes.flatMap((n) => [n.name, ...n.aliases]));

describe("scripts/seed/taxonomy.json", () => {
  it("validates as a tree", () => {
    const result = validateTaxonomy(taxonomy);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("has exactly the six allergen roots", () => {
    const roots = taxonomy.nodes.filter((n) => n.parent === null);
    expect(roots.map((n) => n.name).sort()).toEqual([...ALLERGENS].sort());
    for (const root of roots) expect(root.allergenTags).toEqual([root.name]);
  });

  it("has about 40 nodes", () => {
    expect(taxonomy.nodes.length).toBeGreaterThanOrEqual(35);
    expect(taxonomy.nodes.length).toBeLessThanOrEqual(55);
  });

  it("makes clarified butter dairy by inheritance", () => {
    expect(effectiveAllergenTags(nodes, "clarified butter")).toContain("dairy");
  });

  it("puts peanut under nuts", () => {
    expect(effectiveAllergenTags(nodes, "peanut")).toContain("nuts");
  });

  it("tags soy sauce with both soy and gluten", () => {
    expect(effectiveAllergenTags(nodes, "soy sauce")).toEqual(new Set(["soy", "gluten"]));
  });

  it.each(["soy sauce", "miso"])("excludes %s from a gluten-free search", (name) => {
    // Both sit under soy and are commonly made with wheat or barley.
    expect(exclusionIds(nodes, "gluten")).toContain(name);
  });

  it.each([
    ["wheat flour", "soy sauce"],
    ["barley", "miso"],
  ])("'no %s' also removes %s", (excluded, tagged) => {
    expect(exclusionIds(nodes, excluded)).toContain(tagged);
  });

  it.each([
    ["egg white", "egg"],
    ["peanut", "nuts"],
    ["prawn", "shellfish"],
  ])("'no %s' also removes a recipe that only says %s", (excluded, generic) => {
    // Recipe lines like "3 eggs" or "nuts" resolve to the generic node.
    expect(exclusionIds(nodes, excluded)).toContain(generic);
  });

  it("puts every ancestor of a node inside that node's exclusion", () => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      const excluded = exclusionIds(nodes, n.id);
      for (let p = n.parentId; p !== null; p = byId.get(p)?.parentId ?? null) {
        expect(excluded, `${n.name} -> ${p}`).toContain(p);
      }
    }
  });

  it.each(ALLERGENS)("excludes every node whose tags include %s", (allergen) => {
    // Ties the two readings of the tree together: whatever effectiveAllergenTags
    // says is dairy, the exclusion gate 2 runs must remove.
    const excluded = exclusionIds(nodes, allergen);
    for (const n of nodes) {
      if (effectiveAllergenTags(nodes, n.id).has(allergen)) expect(excluded, n.name).toContain(n.id);
    }
  });

  it("makes egg pasta both gluten and egg, so an egg-free search can tell it from pasta", () => {
    expect(effectiveAllergenTags(nodes, "egg pasta")).toEqual(new Set(["gluten", "egg"]));
    expect(exclusionIds(nodes, "egg")).toContain("egg pasta");
    expect(exclusionIds(nodes, "egg")).not.toContain("pasta");
  });

  it.each([
    ["oyster sauce", ["shellfish", "gluten"]],
    ["hoisin sauce", ["soy", "gluten"]],
    ["green curry paste", ["shellfish"]],
    ["worcestershire sauce", ["gluten"]],
    ["dark chocolate", ["dairy", "soy"]],
  ])("files %s under its hidden allergens", (name, tags) => {
    // Generated as untagged roots and caught in #16's hand review: each passed every
    // schema check while hiding an allergen, which is why generation never files tags.
    expect(effectiveAllergenTags(nodes, name)).toEqual(new Set(tags));
  });

  it.each(["ghee", "panko"])("leaves %s unresolvable, for the review demo", (term) => {
    expect(terms.has(term)).toBe(false);
  });

  it("'no wheat' removes every wheat product and the gluten-tagged sauces", () => {
    // A wheat allergy is not only flour: bread and pasta are made from it.
    const excluded = exclusionIds(nodes, "wheat");
    for (const name of [
      "wheat flour",
      "bread",
      "breadcrumbs",
      "japanese breadcrumbs",
      "pasta",
      "egg pasta",
      "couscous",
      "soy sauce",
      "miso",
    ]) {
      expect(excluded, name).toContain(name);
    }
  });

  it("resolves 'flour' and 'wheat' to the wheat node", () => {
    // "no flour" resolving to wheat flour alone would still offer bread and pasta.
    const index = buildResolutionIndex(
      taxonomy.nodes.flatMap((n) => [n.name, ...n.aliases].map((term) => ({ term, canonicalId: n.name }))),
    );
    const results = resolveExclusions(["flour", "wheat", "Flour "], index);
    expect(results.map((r) => (r.kind === "resolved" ? r.canonicalId : r.kind))).toEqual(["wheat", "wheat"]);
    const excluded = exclusionIds(nodes, "wheat");
    expect(excluded).toContain("bread");
    expect(excluded).toContain("pasta");
  });

  it("'no wheat' leaves the other gluten grains alone", () => {
    const excluded = exclusionIds(nodes, "wheat");
    for (const name of ["oats", "barley", "rye", "worcestershire sauce"]) {
      expect(excluded, name).not.toContain(name);
    }
  });

  it("'no gluten' removes the same ingredients as before the wheat node, plus wheat", () => {
    expect([...exclusionIds(nodes, "gluten")].sort()).toEqual([
      "barley",
      "bread",
      "breadcrumbs",
      "couscous",
      "egg pasta",
      "gluten",
      "hoisin sauce",
      "japanese breadcrumbs",
      "miso",
      "oats",
      "oyster sauce",
      "pasta",
      "rye",
      "soy sauce",
      "wheat",
      "wheat flour",
      "worcestershire sauce",
    ]);
  });

  it("never repeats an inherited tag on a child", () => {
    // A child carries a tag only for a second allergen its parent chain lacks.
    for (const n of taxonomy.nodes) {
      if (n.parent === null) continue;
      const inherited = effectiveAllergenTags(nodes, n.parent);
      for (const tag of n.allergenTags) expect(inherited, `${n.name}: ${tag}`).not.toContain(tag);
    }
  });
});
