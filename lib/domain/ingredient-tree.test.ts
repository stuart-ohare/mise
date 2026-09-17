import { describe, expect, it } from "vitest";

import {
  effectiveAllergenTags,
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
