// @gate resolution
import { describe, expect, it } from "vitest";

import type { DraftRecipe } from "@/lib/domain/intake-draft";

import { scoreRecipeRuns, type ScoredRecipeRun } from "./recipe-extraction";

/**
 * Offline. The scorer is where "did it invent this?" is decided, so it is pinned without
 * a model call: every draft below is hand-written, in the shape one would arrive in.
 */

type Expected = ScoredRecipeRun["expected"];
type Line = DraftRecipe["ingredients"][number];

function line(over: Partial<Line> = {}): Line {
  return {
    rawText: "1 head of cabbage",
    name: "cabbage",
    qty: 1,
    unit: "head",
    optional: false,
    confidence: 0.9,
    ...over,
  };
}

function draft(over: Partial<DraftRecipe> = {}): DraftRecipe {
  return {
    title: "Charred cabbage with anchovy butter",
    serves: 2,
    minutes: 35,
    ingredients: [line()],
    steps: ["Char the cabbage."],
    confidence: { title: 0.9, serves: 0.8, minutes: 0.8 },
    ...over,
  };
}

const ok = (expected: Expected, over: Partial<DraftRecipe> = {}): ScoredRecipeRun => ({
  expected,
  result: { ok: true, draft: draft(over) },
});

/** A source that states everything `draft()` returns. Nothing for null precision to weigh. */
const stated: Expected = {
  title: "Charred cabbage with anchovy butter",
  serves: 2,
  minutes: 35,
  ingredients: [{ name: "cabbage", qty: 1, unit: "head" }],
};

/** The same source with no serving count in it: one unstated field, so null precision is that field. */
const noServes: Expected = { ...stated, serves: null };

/** And with a bare ingredient line: "cabbage", no number, no unit. */
const noQty: Expected = { ...stated, ingredients: [{ name: "cabbage", qty: null, unit: null }] };

describe("scoreRecipeRuns", () => {
  it("reports exactly the two metrics the thresholds name", () => {
    expect(Object.keys(scoreRecipeRuns([ok(noServes, { serves: null })])).sort()).toEqual([
      "field_accuracy",
      "null_precision",
    ]);
  });

  it("scores a run that read every stated field and invented nothing as 1 on both", () => {
    expect(scoreRecipeRuns([ok(noServes, { serves: null })])).toEqual({ field_accuracy: 1, null_precision: 1 });
  });

  // The reason the suite exists. A plausible serving count for a source that never gave
  // one is not an accuracy failure — accuracy is untouched — it is its own kind of wrong.
  it("scores an invented serves as a null-precision miss, not an accuracy miss", () => {
    const metrics = scoreRecipeRuns([ok(noServes, { serves: 4 })]);
    expect(metrics.null_precision).toBe(0);
    expect(metrics.field_accuracy).toBe(1);
  });

  it("scores an invented quantity and unit on a bare line as null-precision misses", () => {
    const metrics = scoreRecipeRuns([ok(noQty, { ingredients: [line({ rawText: "cabbage" })] })]);
    expect(metrics.null_precision).toBe(0);
    expect(metrics.field_accuracy).toBe(1);
  });

  // A line the source never had is a value invented for something unstated, like any other.
  it("scores an ingredient line matching nothing in the source as a null-precision miss", () => {
    const invented = line({ rawText: "2 tbsp olive oil", name: "olive oil", qty: 2, unit: "tbsp" });
    const metrics = scoreRecipeRuns([ok(stated, { ingredients: [line(), invented] })]);
    expect(metrics.null_precision).toBe(0);
    expect(metrics.field_accuracy).toBe(1);
  });

  it("counts a dropped ingredient line as an accuracy miss", () => {
    const metrics = scoreRecipeRuns([ok(stated, { ingredients: [line({ name: "anchovies" })] })]);
    expect(metrics.field_accuracy).toBe(0.75);
  });

  it("accepts any listed spelling of an ingredient, compared as gate 1 compares terms", () => {
    const expected: Expected = { ...stated, ingredients: [{ name: ["cabbage", "green cabbage"], qty: 1, unit: "head" }] };
    const metrics = scoreRecipeRuns([ok(expected, { ingredients: [line({ name: "Green Cabbage", unit: "HEAD" })] })]);
    expect(metrics.field_accuracy).toBe(1);
  });

  // Null because nothing came back is not the same answer as null because the model read
  // the text and found nothing there — the rule call 1's suite applies to a failed run.
  it("scores a failed call as a miss on both, including the field it stated nothing about", () => {
    const metrics = scoreRecipeRuns([{ expected: noServes, result: { ok: false, reason: "api_error" } }]);
    expect(metrics).toEqual({ field_accuracy: 0, null_precision: 0 });
  });

  it("averages over runs", () => {
    const hit = ok(noServes, { serves: null });
    const miss = ok(noServes, { serves: 4 });
    expect(scoreRecipeRuns([hit, miss]).null_precision).toBe(0.5);
  });

  // Nothing measured is not a pass. A fixture set that stated every field would otherwise
  // report a flawless 1 on the metric pegged at 1, having weighed nothing at all.
  it("scores null precision as 0 when no run left a field unstated", () => {
    expect(scoreRecipeRuns([ok(stated)])).toEqual({ field_accuracy: 1, null_precision: 0 });
  });

  it("weighs a bare line's qty and unit separately", () => {
    const metrics = scoreRecipeRuns([ok(noQty, { ingredients: [line({ rawText: "cabbage", qty: null })] })]);
    expect(metrics.null_precision).toBe(0.5);
  });
});
