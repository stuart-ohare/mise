import { z } from "zod";

import { MODELS } from "@/lib/ai/client";
import { extractRecipe, VERSION } from "@/lib/ai/prompts/extract-recipe";
import type { RecipeExtractionResult } from "@/lib/ai/prompts/extract-recipe";
import type { DraftRecipe } from "@/lib/domain/intake-draft";
import { normaliseTerm } from "@/lib/domain/resolve-exclusions";

import { defineSuite } from "../harness";
import { expectedTermSchema } from "./constraint-extraction";

/**
 * Call 2 against hand-written sources, asking two questions that fail for different
 * reasons and are therefore reported apart: did it read the fields the source states,
 * and did it invent a value for a field the source is silent about.
 *
 * Only the second is pegged at 1. A reviewer fills in a blank and skims past a plausible
 * number, so an invented value is the failure this suite exists to catch.
 */

export const RUNS_PER_FIXTURE = 3;

/** One expected line. `qty` and `unit` are null when the source states none. */
export const expectedIngredientSchema = z.object({
  name: expectedTermSchema,
  qty: z.number().positive().nullable(),
  unit: z.string().min(1).nullable(),
});

export const recipeFixtureSchema = z.object({
  source: z.string().min(1),
  /** `null` means the source never states it — the value the model must not invent. */
  expected: z.object({
    title: z.string().min(1),
    serves: z.number().int().positive().nullable(),
    minutes: z.number().int().positive().nullable(),
    ingredients: z.array(expectedIngredientSchema).min(1),
  }),
});

export type RecipeFixture = z.infer<typeof recipeFixtureSchema>;

export interface ScoredRecipeRun {
  expected: RecipeFixture["expected"];
  result: RecipeExtractionResult;
}

/** Hits over units weighed. Zero units is 0, never a vacuous 1 — see `scoreRecipeRuns`. */
class Tally {
  private hits = 0;
  private units = 0;

  add(hit: boolean): void {
    this.units++;
    if (hit) this.hits++;
  }

  get share(): number {
    return this.units === 0 ? 0 : this.hits / this.units;
  }

  /** Zero means the runs gave this metric nothing to weigh, which `share` reports as 0. */
  get weighed(): number {
    return this.units;
  }
}

const same = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : normaliseTerm(a) === normaliseTerm(b);

/**
 * Lines are paired by name, the way gate 1 pairs terms: exact after `normaliseTerm`, and
 * each actual line fills at most one expected slot. What is left over is a line the
 * source never had.
 */
function pairLines(
  expected: RecipeFixture["expected"]["ingredients"],
  actual: readonly DraftRecipe["ingredients"][number][],
): { pairs: { want: RecipeFixture["expected"]["ingredients"][number]; got: DraftRecipe["ingredients"][number] | undefined }[]; invented: number } {
  const unused = [...actual];
  const pairs = expected.map((want) => {
    const spellings = (typeof want.name === "string" ? [want.name] : want.name).map(normaliseTerm);
    const at = unused.findIndex((line) => spellings.includes(normaliseTerm(line.name)));
    return { want, got: at === -1 ? undefined : unused.splice(at, 1)[0] };
  });
  return { pairs, invented: unused.length };
}

/**
 * Two metrics over two different denominators.
 *
 * `field_accuracy` weighs what the source states: the title, the scalars it gives, each
 * expected line's presence, and the quantity and unit of the lines that were found. A
 * dropped line is one miss, not three — the fields under it were never compared.
 *
 * `null_precision` weighs what the source doesn't: the scalars it omits, the quantity and
 * unit of the bare lines it lists, and every returned line the source never had. A `null`
 * scores; any value at all does not.
 *
 * A failed call misses on every unit either metric would have weighed. A failure is never
 * a correct "the source didn't say" — the same rule call 1's suite applies to `exclude`.
 */
export function scoreRecipeRuns(runs: readonly ScoredRecipeRun[]): Record<string, number> {
  const { accuracy, nullPrecision } = tally(runs);
  return { field_accuracy: accuracy.share, null_precision: nullPrecision.share };
}

function tally(runs: readonly ScoredRecipeRun[]): { accuracy: Tally; nullPrecision: Tally } {
  const accuracy = new Tally();
  const nullPrecision = new Tally();

  for (const { expected, result } of runs) {
    const draft = result.ok ? result.draft : null;

    accuracy.add(draft !== null && same(draft.title, expected.title));
    for (const field of ["serves", "minutes"] as const) {
      const want = expected[field];
      if (want === null) nullPrecision.add(draft !== null && draft[field] === null);
      else accuracy.add(draft !== null && draft[field] === want);
    }

    const { pairs, invented } = pairLines(expected.ingredients, draft?.ingredients ?? []);
    for (const { want, got } of pairs) {
      accuracy.add(got !== undefined);
      if (got === undefined) {
        // Nothing to compare the line's own fields against. Its absence is already the
        // accuracy miss above, and a line that never came back invented nothing — except
        // when the whole call failed, which is scored as a miss on everything expected.
        if (draft === null) {
          if (want.qty === null) nullPrecision.add(false);
          if (want.unit === null) nullPrecision.add(false);
        }
        continue;
      }
      if (want.qty === null) nullPrecision.add(got.qty === null);
      else accuracy.add(got.qty === want.qty);
      if (want.unit === null) nullPrecision.add(got.unit === null);
      else accuracy.add(same(got.unit, want.unit));
    }
    for (let i = 0; i < invented; i++) nullPrecision.add(false);
  }

  return { accuracy, nullPrecision };
}

export const recipeExtraction = defineSuite({
  name: "recipe-extraction",
  prompt: { name: "extract-recipe", version: VERSION },
  model: MODELS.capable,
  fixtureSchema: recipeFixtureSchema,
  async run(fixtures) {
    const runs: ScoredRecipeRun[] = [];
    for (const fixture of fixtures) {
      for (let i = 0; i < RUNS_PER_FIXTURE; i++) {
        // #73 made call 2 take a source rather than a string. These fixtures are
        // pasted text; the image path has no suite yet.
        const result = await extractRecipe({ kind: "text", text: fixture.source });
        runs.push({ expected: fixture.expected, result });
        // The report holds only numbers, and "0.97 on null precision" is useless without
        // knowing which field got invented. A fixture that states everything weighs
        // nothing for null precision, so asking the tally what it weighed is what keeps
        // that from reading as a miss — while still printing an invented line, which is
        // the one thing such a fixture does weigh.
        const { accuracy, nullPrecision } = tally([{ expected: fixture.expected, result }]);
        if (accuracy.share < 1 || (nullPrecision.weighed > 0 && nullPrecision.share < 1)) {
          console.error(
            `✗ ${JSON.stringify(fixture.expected.title)} run ${i + 1}: expected ${JSON.stringify(fixture.expected)}, got ${JSON.stringify(result)}`,
          );
        }
      }
    }
    return scoreRecipeRuns(runs);
  },
});
