// @gate resolution
import { describe, expect, it } from "vitest";

import { aliasStanding, linesMatchingAlias } from "./reresolve";

/**
 * The repair path for gate 1. A human names what an unresolved term means, and every
 * line held by that exact term is re-resolved through the normalisation the index uses —
 * never by reading the raw line, and never by asking a model.
 */

const lines = [
  { id: "a", name: "ghee" },
  { id: "b", name: "  Ghee " },
  { id: "c", name: "panko" },
  // Contains the alias, isn't it. A substring match would file this under butter.
  { id: "d", name: "ghee butter" },
];

describe("linesMatchingAlias", () => {
  it("matches every line whose name is the alias after normalisation, and nothing else", () => {
    expect(linesMatchingAlias(lines, "ghee")).toEqual(["a", "b"]);
  });

  it("normalises the alias the same way as the names", () => {
    expect(linesMatchingAlias(lines, " GHEE")).toEqual(["a", "b"]);
  });

  it("matches nothing when no line carries the term", () => {
    expect(linesMatchingAlias(lines, "brinjal")).toEqual([]);
  });
});

describe("aliasStanding", () => {
  const terms = [
    { term: "clarified butter", canonicalId: "cb" },
    { term: "yogurt", canonicalId: "y" },
  ];

  it("is a conflict when the alias is already an alias of something else, however it is spelled", () => {
    expect(aliasStanding(" Yogurt", "cb", terms)).toBe("conflict");
  });

  it("is a conflict when the alias is already another ingredient's canonical name", () => {
    expect(aliasStanding("Clarified Butter", "y", terms)).toBe("conflict");
  });

  it("is new for a term nothing claims", () => {
    expect(aliasStanding("ghee", "cb", terms)).toBe("new");
  });

  // A line can still be null under a term that already means this ingredient: Intake
  // built its index before the alias landed, or a re-seed added it. Re-resolving is the
  // only way that line's draft ever unblocks.
  it("is known when the term already means the same ingredient, as an alias or a name", () => {
    expect(aliasStanding("YOGURT", "y", terms)).toBe("known");
    expect(aliasStanding("clarified butter", "cb", terms)).toBe("known");
  });

  it("is a conflict when the term is ambiguous, even if one meaning is this ingredient", () => {
    expect(aliasStanding("yogurt", "y", [...terms, { term: "yogurt", canonicalId: "cb" }])).toBe("conflict");
  });
});
