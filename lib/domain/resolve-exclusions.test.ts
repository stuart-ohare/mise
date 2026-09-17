// @gate resolution
import { describe, expect, it } from "vitest";

import { buildResolutionIndex, resolveExclusions } from "./resolve-exclusions";

// Rows shaped like the seed: names and aliases, each pointing at a canonical id.
const index = buildResolutionIndex([
  { term: "dairy", canonicalId: "id-dairy" },
  { term: "butter", canonicalId: "id-butter" },
  { term: "peanut", canonicalId: "id-peanut" },
  { term: "peanuts", canonicalId: "id-peanut" },
  { term: "crème fraîche", canonicalId: "id-creme-fraiche" },
  { term: "creme fraiche", canonicalId: "id-creme-fraiche" },
]);

describe("resolveExclusions", () => {
  it("resolves a term equal to a canonical name", () => {
    expect(resolveExclusions(["butter"], index)).toEqual([
      { kind: "resolved", term: "butter", canonicalId: "id-butter" },
    ]);
  });

  it("resolves a term equal to an alias to the alias's canonical id", () => {
    expect(resolveExclusions(["peanuts"], index)).toEqual([
      { kind: "resolved", term: "peanuts", canonicalId: "id-peanut" },
    ]);
  });

  it("resolves across case and whitespace differences, keeping the term as typed", () => {
    expect(resolveExclusions(["  Dairy ", "PEANUTS", "crème \t  fraîche"], index)).toEqual([
      { kind: "resolved", term: "  Dairy ", canonicalId: "id-dairy" },
      { kind: "resolved", term: "PEANUTS", canonicalId: "id-peanut" },
      { kind: "resolved", term: "crème \t  fraîche", canonicalId: "id-creme-fraiche" },
    ]);
  });

  it("returns an unknown term as unresolved rather than dropping it", () => {
    const results = resolveExclusions(["ghee"], index);
    expect(results).toHaveLength(1);
    expect(results).toEqual([{ kind: "unresolved", term: "ghee" }]);
  });

  it("returns one result per distinct term, resolved and unresolved, in input order", () => {
    expect(resolveExclusions(["ghee", "Dairy", "panko", "dairy", "peanuts"], index)).toEqual([
      { kind: "unresolved", term: "ghee" },
      { kind: "resolved", term: "Dairy", canonicalId: "id-dairy" },
      { kind: "unresolved", term: "panko" },
      { kind: "resolved", term: "peanuts", canonicalId: "id-peanut" },
    ]);
  });

  it("does not resolve a partial match", () => {
    // A wrong fuzzy hit is a silent allergen leak; a miss is only a question.
    expect(resolveExclusions(["peanut butter", "butte", "dairy free"], index)).toEqual([
      { kind: "unresolved", term: "peanut butter" },
      { kind: "unresolved", term: "butte" },
      { kind: "unresolved", term: "dairy free" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(resolveExclusions([], index)).toEqual([]);
  });

  it("resolves a decomposed (NFD) term against a precomposed name", () => {
    const decomposed = "crème fraîche";
    expect(decomposed).not.toBe("crème fraîche");
    expect(resolveExclusions([decomposed], index)).toEqual([
      { kind: "resolved", term: decomposed, canonicalId: "id-creme-fraiche" },
    ]);
  });

  it("resolves a precomposed term against a decomposed name", () => {
    const decomposed = "crème fraîche";
    expect(decomposed).not.toBe("crème fraîche");
    const nfdIndex = buildResolutionIndex([{ term: decomposed, canonicalId: "id-creme-fraiche" }]);
    expect(resolveExclusions(["crème fraîche"], nfdIndex)).toEqual([
      { kind: "resolved", term: "crème fraîche", canonicalId: "id-creme-fraiche" },
    ]);
  });
});

describe("buildResolutionIndex", () => {
  it("leaves a term claimed by two different ids unresolved", () => {
    const ambiguous = buildResolutionIndex([
      { term: "cream", canonicalId: "id-cream" },
      { term: "Cream", canonicalId: "id-ice-cream" },
      { term: "milk", canonicalId: "id-milk" },
    ]);
    expect(resolveExclusions(["cream", "milk"], ambiguous)).toEqual([
      { kind: "unresolved", term: "cream" },
      { kind: "resolved", term: "milk", canonicalId: "id-milk" },
    ]);
  });

  it("keeps a term that the same id claims twice", () => {
    const repeated = buildResolutionIndex([
      { term: "egg", canonicalId: "id-egg" },
      { term: "EGG", canonicalId: "id-egg" },
    ]);
    expect(resolveExclusions(["egg"], repeated)).toEqual([
      { kind: "resolved", term: "egg", canonicalId: "id-egg" },
    ]);
  });
});
