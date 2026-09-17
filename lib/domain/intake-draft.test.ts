// @gate resolution
import { describe, expect, it } from "vitest";

import { buildIntakeDraft, draftRecipeSchema, type DraftRecipe } from "./intake-draft";
import { buildResolutionIndex } from "./resolve-exclusions";

/**
 * Gate 1 on the Intake side. Cook asks the index what an exclusion means; Intake asks it
 * the same question about an ingredient line, through the same builder and the same
 * normalisation — so a change to either moves both together.
 *
 * A line the index doesn't know is `canonical_id = null` and stays that way. Nothing
 * here guesses, and nothing here publishes: an unknown ingredient is exactly where an
 * allergen hides, and the recipe it belongs to must not leave draft.
 */

const BUTTER = "11111111-1111-4111-8111-111111111111";
const FLOUR = "22222222-2222-4222-8222-222222222222";

// "unsalted butter" is an alias, so a line that matches it must still carry butter's id.
const index = buildResolutionIndex([
  { term: "butter", canonicalId: BUTTER },
  { term: "unsalted butter", canonicalId: BUTTER },
  { term: "plain flour", canonicalId: FLOUR },
]);

const names = new Map([
  [BUTTER, "butter"],
  [FLOUR, "plain flour"],
]);

const line = (over: Partial<DraftRecipe["ingredients"][number]> = {}) => ({
  rawText: "150g plain flour",
  name: "plain flour",
  qty: 150,
  unit: "g",
  optional: false,
  confidence: 0.9,
  ...over,
});

function draft(over: Partial<DraftRecipe> = {}): DraftRecipe {
  return draftRecipeSchema.parse({
    title: "Shortcrust pastry",
    serves: 4,
    minutes: 30,
    ingredients: [line()],
    steps: ["Rub the butter into the flour."],
    confidence: { title: 0.95, serves: 0.8, minutes: 0.6 },
    ...over,
  });
}

const build = (over: Partial<DraftRecipe> = {}) => buildIntakeDraft(draft(over), index, names);

describe("buildIntakeDraft", () => {
  it("leaves a line the index doesn't know unresolved, with its raw text intact", () => {
    const result = build({
      ingredients: [line({ rawText: "  2 tbsp ghee, melted ", name: "ghee", qty: 2, unit: "tbsp" })],
    });

    expect(result.ingredients).toEqual([
      {
        canonicalId: null,
        canonicalName: null,
        // Byte-identical, surrounding spaces included: the reviewer sees what the model saw.
        rawText: "  2 tbsp ghee, melted ",
        qty: 2,
        unit: "tbsp",
        optional: false,
        confidence: 0.9,
      },
    ]);
    expect(result.unresolved).toEqual(["  2 tbsp ghee, melted "]);
  });

  it("keeps a recipe with an unresolved line in draft", () => {
    expect(build({ ingredients: [line({ name: "ghee" })] }).recipe.status).toBe("draft");
  });

  it("keeps a recipe in draft even when every line resolved", () => {
    // Not `deriveRecipeStatus`: extraction never writes a published recipe, however
    // clean the draft or however high the scores (CLAUDE.md §2).
    const result = build();
    expect(result.unresolved).toEqual([]);
    expect(result.recipe.status).toBe("draft");
  });

  it("resolves a line naming a canonical ingredient to its id", () => {
    const [ingredient] = build({ ingredients: [line({ name: "plain flour" })] }).ingredients;
    expect(ingredient).toMatchObject({ canonicalId: FLOUR, canonicalName: "plain flour" });
  });

  it("resolves a line matching only an alias, and names the ingredient it belongs to", () => {
    const [ingredient] = build({
      ingredients: [line({ rawText: "100g Unsalted Butter", name: "Unsalted Butter" })],
    }).ingredients;

    // The alias's own id would be the wrong answer, and so would "unsalted butter" as a
    // name: what the line resolved to is butter.
    expect(ingredient).toMatchObject({ canonicalId: BUTTER, canonicalName: "butter" });
  });

  it("writes an unstated quantity as null rather than filling it in", () => {
    const [ingredient] = build({
      ingredients: [line({ rawText: "butter, for the tin", name: "butter", qty: null, unit: null })],
    }).ingredients;

    expect(ingredient).toMatchObject({ qty: null, unit: null, canonicalId: BUTTER });
  });

  it("carries the scalar fields and numbers the steps from one", () => {
    const result = build({ steps: ["Rub in the butter.", "Chill for 30 minutes."] });

    expect(result.recipe).toEqual({
      title: "Shortcrust pastry",
      serves: 4,
      minutes: 30,
      status: "draft",
    });
    expect(result.steps).toEqual([
      { position: 1, text: "Rub in the butter." },
      { position: 2, text: "Chill for 30 minutes." },
    ]);
  });

  it("keys each line's confidence by its raw text, beside the scalar scores", () => {
    const result = build({
      ingredients: [line(), line({ rawText: "100g butter", name: "butter", qty: 100, confidence: 0.4 })],
    });

    expect(result.fieldConfidence).toEqual({
      title: 0.95,
      serves: 0.8,
      minutes: 0.6,
      ingredients: [
        { rawText: "150g plain flour", confidence: 0.9 },
        { rawText: "100g butter", confidence: 0.4 },
      ],
    });
  });
});

describe("draftRecipeSchema", () => {
  it("rejects a quantity of zero or less rather than storing it", () => {
    expect(draftRecipeSchema.safeParse({ ...draft(), ingredients: [line({ qty: 0 })] }).success).toBe(
      false,
    );
  });

  it("rejects a confidence outside 0 to 1", () => {
    const bad = { ...draft(), confidence: { title: 1.4, serves: 0.8, minutes: 0.6 } };
    expect(draftRecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a recipe with no ingredients at all", () => {
    expect(draftRecipeSchema.safeParse({ ...draft(), ingredients: [] }).success).toBe(false);
  });
});
