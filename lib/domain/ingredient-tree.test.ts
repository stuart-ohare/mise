// @gate query
import { describe, expect, it } from "vitest";

import {
  effectiveAllergenTags,
  exclusionIds,
  subtreeIds,
  type IngredientNode,
} from "./ingredient-tree";

// dairy -> butter -> ghee, plus an unrelated branch.
const nodes: IngredientNode[] = [
  { id: "dairy", name: "dairy", parentId: null, allergenTags: ["dairy"] },
  { id: "butter", name: "butter", parentId: "dairy", allergenTags: [] },
  { id: "ghee", name: "ghee", parentId: "butter", allergenTags: [] },
  { id: "cream", name: "cream", parentId: "dairy", allergenTags: [] },
  { id: "veg", name: "vegetable", parentId: null, allergenTags: [] },
  { id: "cauliflower", name: "cauliflower", parentId: "veg", allergenTags: [] },
];

describe("subtreeIds", () => {
  it("collects every descendant of an excluded root", () => {
    expect(subtreeIds(nodes, "dairy")).toEqual(
      new Set(["dairy", "butter", "ghee", "cream"]),
    );
  });

  it("does not leak across branches", () => {
    expect(subtreeIds(nodes, "veg")).toEqual(new Set(["veg", "cauliflower"]));
  });

  it("returns just the node for a leaf", () => {
    expect(subtreeIds(nodes, "ghee")).toEqual(new Set(["ghee"]));
  });
});

describe("effectiveAllergenTags", () => {
  it("inherits a tag from an ancestor two levels up", () => {
    // This is the whole point: nobody tagged ghee, and ghee is still dairy.
    expect(effectiveAllergenTags(nodes, "ghee")).toEqual(new Set(["dairy"]));
  });

  it("returns nothing for an unrelated branch", () => {
    expect(effectiveAllergenTags(nodes, "cauliflower")).toEqual(new Set());
  });
});

describe("exclusionIds", () => {
  // The tree is single-parent, so soy sauce sits under soy and carries gluten as its
  // own tag. Gate 2 must still exclude it from a gluten-free search.
  const multi: IngredientNode[] = [
    { id: "gluten", name: "gluten", parentId: null, allergenTags: ["gluten"] },
    { id: "bread", name: "bread", parentId: "gluten", allergenTags: [] },
    { id: "soy", name: "soy", parentId: null, allergenTags: ["soy"] },
    { id: "tofu", name: "tofu", parentId: "soy", allergenTags: [] },
    { id: "soy sauce", name: "soy sauce", parentId: "soy", allergenTags: ["gluten"] },
    { id: "tamari", name: "tamari", parentId: "soy sauce", allergenTags: [] },
  ];

  it("excludes a node tagged with an excluded allergen outside that allergen's subtree", () => {
    expect(exclusionIds(multi, "gluten")).toEqual(
      new Set(["gluten", "bread", "soy sauce", "tamari"]),
    );
  });

  it("does not pull the other allergen's nodes into the exclusion", () => {
    expect(exclusionIds(multi, "soy")).toEqual(new Set(["soy", "tofu", "soy sauce", "tamari"]));
  });

  it("is just the subtree when the excluded node isn't an allergen root", () => {
    // Excluding soy sauce must not exclude every gluten ingredient.
    expect(exclusionIds(multi, "soy sauce")).toEqual(new Set(["soy sauce", "tamari"]));
  });
});
