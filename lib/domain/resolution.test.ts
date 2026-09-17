import { describe, expect, it } from "vitest";

import { buildNameIndex, deriveRecipeStatus, resolveTerm } from "./resolution";

const index = buildNameIndex([
  { term: "butter", id: "butter-id" },
  { term: "clarified butter", id: "clarified-id" },
  { term: "egg", id: "egg-id" },
  { term: "eggs", id: "egg-id" },
]);

describe("resolveTerm", () => {
  it("matches a name regardless of case and surrounding space", () => {
    expect(resolveTerm("butter", index)).toBe("butter-id");
    expect(resolveTerm(" BUTTER ", index)).toBe("butter-id");
  });

  it("collapses internal whitespace as gate 1 does", () => {
    expect(resolveTerm("king  prawn", buildNameIndex([{ term: "king prawn", id: "p" }]))).toBe("p");
  });

  it("matches an alias to its canonical id", () => {
    expect(resolveTerm("Eggs", index)).toBe("egg-id");
  });

  it("does not match a partial term", () => {
    // A near miss goes to review. Guessing "unsalted butter" is butter is how the
    // wrong node gets picked the one time it matters.
    expect(resolveTerm("unsalted butter", index)).toBeNull();
    expect(resolveTerm("butt", index)).toBeNull();
  });

  it("does not resolve a term that is in no name or alias", () => {
    expect(resolveTerm("ghee", index)).toBeNull();
  });
});

describe("buildNameIndex", () => {
  it("refuses a term that points at two ingredients", () => {
    expect(() =>
      buildNameIndex([
        { term: "cream", id: "cream-id" },
        { term: "Cream", id: "butter-id" },
      ]),
    ).toThrow(/cream/);
  });

  it("accepts the same term twice when it points at the same ingredient", () => {
    expect(resolveTerm("egg", buildNameIndex([
      { term: "egg", id: "egg-id" },
      { term: "EGG", id: "egg-id" },
    ]))).toBe("egg-id");
  });
});

describe("deriveRecipeStatus", () => {
  it("publishes a recipe whose every ingredient resolved", () => {
    expect(deriveRecipeStatus([{ canonicalId: "a", optional: false }, { canonicalId: "b", optional: true }])).toBe(
      "published",
    );
  });

  it("keeps a recipe with an unresolved ingredient in draft", () => {
    expect(deriveRecipeStatus([{ canonicalId: "a", optional: false }, { canonicalId: null, optional: false }])).toBe(
      "draft",
    );
  });

  it("keeps a recipe in draft when only an optional ingredient is unresolved", () => {
    // Optional ghee is still ghee: an unknown ingredient is where an allergen hides.
    expect(deriveRecipeStatus([{ canonicalId: "a", optional: false }, { canonicalId: null, optional: true }])).toBe(
      "draft",
    );
  });

  it("keeps a recipe with no ingredients in draft", () => {
    expect(deriveRecipeStatus([])).toBe("draft");
  });
});
