// @gate resolution
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildResolutionIndex, normaliseTerm } from "@/lib/domain/resolve-exclusions";
import { leavesSchema } from "@/lib/ai/prompts/seed-catalogue";
import { taxonomySchema } from "@/lib/domain/taxonomy";

import { GATES } from "./harness";
import { constraintFixtureSchema } from "./suites/constraint-extraction";
import { recipeFixtureSchema } from "./suites/recipe-extraction";

// Offline checks on the constraint-extraction fixtures. The model isn't called: this
// proves the fixtures are well-formed and that every exclusion they expect call 1 to
// produce is a term gate 1 can resolve against the seed — so a passing eval means
// extraction hands gate 1 something it can act on, not just a string that looks right.

const root = resolve(__dirname, "..");
const dir = join(root, "evals/fixtures/constraint-extraction");

const read = (from: string) => {
  const names = (() => {
    try {
      return readdirSync(from).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
  })();
  return {
    files: names,
    fixtures: names.map((file) => ({ file, json: JSON.parse(readFileSync(join(from, file), "utf8")) as unknown })),
  };
};

const { files, fixtures } = read(dir);
const recipe = read(join(root, "evals/fixtures/recipe-extraction"));

const taxonomy = taxonomySchema.parse(JSON.parse(readFileSync(join(root, "scripts/seed/taxonomy.json"), "utf8")));
const leaves = leavesSchema.parse(JSON.parse(readFileSync(join(root, "scripts/seed/leaves.json"), "utf8")));
const index = buildResolutionIndex([
  ...taxonomy.nodes.flatMap((n) => [n.name, ...n.aliases].map((term) => ({ term, canonicalId: n.name }))),
  ...leaves.nodes.map((n) => ({ term: n.name, canonicalId: n.name })),
]);

const spellings = (term: string | readonly string[]) => (typeof term === "string" ? [term] : [...term]);

describe("constraint-extraction fixtures", () => {
  it("has the 17 hand-written fixtures", () => {
    expect(files).toHaveLength(17);
  });

  it.each(fixtures)("$file declares gate resolution and parses", ({ json }) => {
    expect(constraintFixtureSchema.safeParse(json).success).toBe(true);
    expect(json).toMatchObject({ gates: ["resolution"] });
    expect(GATES).toContain("resolution");
  });

  it.each(fixtures)("$file expects only exclusions gate 1 can resolve", ({ json }) => {
    const { expected } = constraintFixtureSchema.parse(json);
    for (const term of expected.exclude.flatMap(spellings)) {
      expect(index.get(normaliseTerm(term)), `"${term}" doesn't resolve`).toBeDefined();
    }
  });

  // Variants are spellings of one ingredient, so no spelling may belong to two slots.
  it.each(fixtures)("$file never lists one spelling under two expected terms", ({ json }) => {
    const { expected } = constraintFixtureSchema.parse(json);
    for (const field of [expected.exclude, expected.avoid, expected.have]) {
      const all = field.flatMap(spellings).map(normaliseTerm);
      expect(new Set(all).size).toBe(all.length);
    }
  });
});

// The recipe fixtures aren't checked against the seed: a source naming an ingredient the
// catalogue doesn't know is the unresolved state working, not a broken fixture. What is
// checked is that the set still contains the cases the suite was built to measure —
// silence about a quantity, and silence about how many it feeds.

describe("recipe-extraction fixtures", () => {
  it("has the six hand-written fixtures", () => {
    expect(recipe.files).toHaveLength(6);
  });

  it.each(recipe.fixtures)("$file declares gate resolution and parses", ({ json }) => {
    expect(recipeFixtureSchema.safeParse(json).success).toBe(true);
    expect(json).toMatchObject({ gates: ["resolution"] });
    expect(GATES).toContain("resolution");
  });

  it.each(recipe.fixtures)("$file never lists one spelling under two ingredients", ({ json }) => {
    const { expected } = recipeFixtureSchema.parse(json);
    const all = expected.ingredients.flatMap((line) => spellings(line.name)).map(normaliseTerm);
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps at least two sources that state no quantity for an ingredient", () => {
    const bare = recipe.fixtures.filter(({ json }) =>
      recipeFixtureSchema.parse(json).expected.ingredients.some((line) => line.qty === null),
    );
    expect(bare.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps at least one source that never says how many it serves", () => {
    const silent = recipe.fixtures.filter(({ json }) => recipeFixtureSchema.parse(json).expected.serves === null);
    expect(silent.length).toBeGreaterThanOrEqual(1);
  });
});
