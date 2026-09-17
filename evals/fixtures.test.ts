// @gate resolution
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildResolutionIndex, normaliseTerm } from "@/lib/domain/resolve-exclusions";
import { leavesSchema } from "@/lib/ai/prompts/seed-catalogue";
import { taxonomySchema } from "@/lib/domain/taxonomy";

import { GATES } from "./harness";
import { constraintFixtureSchema } from "./suites/constraint-extraction";

// Offline checks on the constraint-extraction fixtures. The model isn't called: this
// proves the fixtures are well-formed and that every exclusion they expect call 1 to
// produce is a term gate 1 can resolve against the seed — so a passing eval means
// extraction hands gate 1 something it can act on, not just a string that looks right.

const root = resolve(__dirname, "..");
const dir = join(root, "evals/fixtures/constraint-extraction");

const files = (() => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
})();

const fixtures = files.map((file) => ({
  file,
  json: JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown,
}));

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
