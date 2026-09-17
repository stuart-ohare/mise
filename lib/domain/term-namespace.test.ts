import { describe, expect, it } from "vitest";

import { findTermCollisions } from "./term-namespace";

// Gate 1 resolves a term against names and aliases alike, so a term claimed by two
// ingredients has no safe answer. These are the claims the seed checks before writing.

describe("findTermCollisions", () => {
  it("reports a term that is one ingredient's name and another's alias", () => {
    // An existing node `shrimp`, and the file's alias shrimp → prawn.
    expect(
      findTermCollisions([
        { term: "shrimp", ingredient: "shrimp" },
        { term: "prawn", ingredient: "prawn" },
        { term: "shrimp", ingredient: "prawn" },
      ]),
    ).toEqual([{ term: "shrimp", ingredients: ["prawn", "shrimp"] }]);

    // The reverse: an existing alias shrimp → prawn, and a new node `shrimp`.
    expect(
      findTermCollisions([
        { term: "prawn", ingredient: "prawn" },
        { term: "shrimp", ingredient: "prawn" },
        { term: "shrimp", ingredient: "shrimp" },
      ]),
    ).toEqual([{ term: "shrimp", ingredients: ["prawn", "shrimp"] }]);
  });

  it("reports an alias claimed by two ingredients", () => {
    expect(
      findTermCollisions([
        { term: "single cream", ingredient: "cream" },
        { term: "single cream", ingredient: "butter" },
      ]),
    ).toEqual([{ term: "single cream", ingredients: ["butter", "cream"] }]);
  });

  it("collides terms that differ only in case, whitespace or Unicode form", () => {
    expect(
      findTermCollisions([
        { term: "king prawn", ingredient: "king prawn" },
        { term: " King  Prawn ", ingredient: "prawn" },
      ]),
    ).toEqual([{ term: "king prawn", ingredients: ["king prawn", "prawn"] }]);

    const nfc = "crème fraîche".normalize("NFC");
    const nfd = "crème fraîche".normalize("NFD");
    expect(
      findTermCollisions([
        { term: nfc, ingredient: "crème fraîche" },
        { term: nfd, ingredient: "cream" },
      ]),
    ).toEqual([{ term: nfc, ingredients: ["cream", "crème fraîche"] }]);
  });

  it("does not report a term claimed twice by the same ingredient", () => {
    // The database already holds the seed: every claim in the files is repeated.
    expect(
      findTermCollisions([
        { term: "prawn", ingredient: "prawn" },
        { term: "prawn", ingredient: "prawn" },
        { term: "Shrimp", ingredient: "prawn" },
        { term: "shrimp", ingredient: "prawn" },
      ]),
    ).toEqual([]);
  });

  it("treats names that differ only in case as two ingredients", () => {
    // The unique index is case-sensitive, so these would be two rows.
    expect(
      findTermCollisions([
        { term: "Prawn", ingredient: "Prawn" },
        { term: "prawn", ingredient: "prawn" },
      ]),
    ).toEqual([{ term: "prawn", ingredients: ["Prawn", "prawn"] }]);
  });

  it("returns nothing for no claims", () => {
    expect(findTermCollisions([])).toEqual([]);
  });
});
