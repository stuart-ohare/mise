import { describe, expect, it } from "vitest";

import { findTreeChanges, type TreeNode } from "./tree-changes";

// Gate 2 walks the tree: moving a node, or changing its tags, moves every recipe under it
// into or out of an exclusion. These are the differences the seed refuses to write unasked.

const node = (name: string, parent: string | null, allergenTags: string[] = []): TreeNode => ({
  name,
  parent,
  allergenTags,
});

describe("findTreeChanges", () => {
  it("reports a node whose parent changed", () => {
    expect(findTreeChanges([node("pasta", "gluten")], [node("pasta", "wheat")])).toEqual([
      { name: "pasta", parent: { from: "gluten", to: "wheat" } },
    ]);
    expect(
      findTreeChanges(
        [node("cream", null), node("dairy", "cream")],
        [node("cream", "dairy"), node("dairy", null)],
      ),
    ).toEqual([
      { name: "cream", parent: { from: null, to: "dairy" } },
      { name: "dairy", parent: { from: "cream", to: null } },
    ]);
  });

  it("reports a node whose tags changed", () => {
    expect(findTreeChanges([node("miso", "soy")], [node("miso", "soy", ["gluten"])])).toEqual([
      { name: "miso", tags: { from: [], to: ["gluten"] } },
    ]);
    expect(
      findTreeChanges([node("miso", null, ["soy"])], [node("miso", "soy", ["gluten"])]),
    ).toEqual([{ name: "miso", parent: { from: null, to: "soy" }, tags: { from: ["soy"], to: ["gluten"] } }]);
  });

  it("ignores tag order and duplicates", () => {
    expect(
      findTreeChanges([node("soy sauce", "soy", ["soy", "gluten"])], [node("soy sauce", "soy", ["gluten", "soy", "gluten"])]),
    ).toEqual([]);
  });

  it("does not report nodes only in the files, only in the database, or identical", () => {
    expect(
      findTreeChanges(
        [node("butter", "dairy"), node("fixture", null)],
        [node("butter", "dairy"), node("wheat", "gluten")],
      ),
    ).toEqual([]);
  });

  it("returns nothing for no nodes", () => {
    expect(findTreeChanges([], [])).toEqual([]);
  });
});
