// @gate resolution
import { describe, expect, it } from "vitest";

import { aliasConflict, linesMatchingAlias } from "./reresolve";

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

describe("aliasConflict", () => {
  const terms = [
    { term: "clarified butter", canonicalId: "cb" },
    { term: "yogurt", canonicalId: "y" },
  ];

  it("is a conflict when the alias is already an alias, however it is spelled", () => {
    expect(aliasConflict(" Yogurt", terms)).toBe(true);
  });

  it("is a conflict when the alias is already a canonical name", () => {
    expect(aliasConflict("Clarified Butter", terms)).toBe(true);
  });

  it("is not a conflict for a term nothing claims", () => {
    expect(aliasConflict("ghee", terms)).toBe(false);
  });
});
