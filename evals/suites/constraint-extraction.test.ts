// @gate resolution
import { describe, expect, it } from "vitest";

import { scoreConstraintRuns, type ScoredRun } from "./constraint-extraction";

const none = { exclude: [], avoid: [], have: [], maxMinutes: null };

describe("scoreConstraintRuns", () => {
  it("reports exactly the four metrics the thresholds name", () => {
    const metrics = scoreConstraintRuns([
      { expected: none, result: { ok: true, constraints: none } },
    ]);
    expect(Object.keys(metrics).sort()).toEqual(["avoid_f1", "exclude_exact", "have_f1", "max_minutes_exact"]);
  });

  it("scores every field of a perfect run as 1", () => {
    const expected = { exclude: ["dairy"], avoid: [["curry", "curries"]], have: ["cauliflower"], maxMinutes: 25 };
    const constraints = { exclude: ["Dairy"], avoid: ["curries"], have: ["cauliflower"], maxMinutes: 25 };
    expect(scoreConstraintRuns([{ expected, result: { ok: true, constraints } }])).toEqual({
      exclude_exact: 1,
      avoid_f1: 1,
      have_f1: 1,
      max_minutes_exact: 1,
    });
  });

  it("counts an extra exclusion as an exclude mismatch", () => {
    const run: ScoredRun = {
      expected: { ...none, exclude: ["dairy"] },
      result: { ok: true, constraints: { ...none, exclude: ["dairy", "butter"] } },
    };
    expect(scoreConstraintRuns([run]).exclude_exact).toBe(0);
  });

  // A failed call is never a correct "no exclusions", even when none were expected.
  it("scores a failed run as an exclude and maxMinutes mismatch even when nothing was expected", () => {
    const metrics = scoreConstraintRuns([{ expected: none, result: { ok: false, reason: "api_error" } }]);
    expect(metrics.exclude_exact).toBe(0);
    expect(metrics.max_minutes_exact).toBe(0);
  });

  it("counts a failed run's expected have and avoid terms as false negatives", () => {
    const metrics = scoreConstraintRuns([
      { expected: { ...none, have: ["leek"], avoid: ["pasta"] }, result: { ok: false, reason: "parse_failed" } },
      { expected: { ...none, have: ["leek"], avoid: ["pasta"] }, result: { ok: true, constraints: { ...none, have: ["leek"], avoid: ["pasta"] } } },
    ]);
    expect(metrics.have_f1).toBeCloseTo(2 / 3);
    expect(metrics.avoid_f1).toBeCloseTo(2 / 3);
  });

  it("averages exact metrics over runs", () => {
    const ok: ScoredRun = { expected: { ...none, exclude: ["gluten"] }, result: { ok: true, constraints: { ...none, exclude: ["gluten"] } } };
    const miss: ScoredRun = { expected: { ...none, exclude: ["gluten"] }, result: { ok: true, constraints: none } };
    expect(scoreConstraintRuns([ok, ok, miss, ok]).exclude_exact).toBe(0.75);
  });
});
