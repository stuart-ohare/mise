import { describe, expect, it } from "vitest";

import type { Constraints } from "@/lib/domain/constraints";

import type { CookResponse } from "../api/cook/schema";
import { understoodFrom } from "./understood";

const constraints: Constraints = {
  exclude: ["dairy", "ghee"],
  avoid: [],
  have: [],
  maxMinutes: null,
};

const recipe = { id: "r1", title: "Toast", summary: null, minutes: 5, serves: 1 };

describe("understoodFrom", () => {
  // The whole point of the pairing: an unresolved exclusion may never be separated from
  // the constraint set that contains it. If the two are derived independently, a screen
  // holding stale constraints can lose the unresolved list and offer to demote a term
  // gate 1 never mapped — which drops the exclusion the cook asked for.
  it("carries the unresolved terms with the constraints that contain them", () => {
    const response: CookResponse = { kind: "needs_resolution", constraints, unresolved: ["ghee"] };

    expect(understoodFrom(response)).toEqual({ constraints, unresolved: ["ghee"] });
  });

  it("pairs an empty unresolved list with every outcome that resolved cleanly", () => {
    const outcomes: CookResponse[] = [
      { kind: "ranked", constraints, results: [{ recipe, rationale: "Quick." }], attempts: 1 },
      { kind: "cards", constraints, results: [recipe], reason: "output_violation" },
      { kind: "no_candidates", constraints, relaxTime: null },
    ];

    for (const response of outcomes) {
      expect(understoodFrom(response)).toEqual({ constraints, unresolved: [] });
    }
  });

  it("returns nothing when the request was never understood", () => {
    expect(understoodFrom({ kind: "not_understood", reason: "empty_query" })).toBeNull();
  });
});
