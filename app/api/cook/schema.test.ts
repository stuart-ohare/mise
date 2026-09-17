import { describe, expect, it } from "vitest";

import type { Constraints } from "@/lib/domain/constraints";

import { cookResponseSchema } from "./schema";

/**
 * The half of the contract `run.test.ts` can't assert: what the boundary refuses. Both
 * ends parse this schema, so a rule stated here holds on the way out of the route and
 * on the way into the screen.
 */

const constraints: Constraints = {
  exclude: [],
  avoid: [],
  have: [],
  maxMinutes: null,
};

describe("cookResponseSchema", () => {
  it("refuses a ranked response carrying no rows", () => {
    // `run.ts` downgrades an all-invented ranking to cards, so this shape means the
    // pipeline regressed. It must fail here — a 500 and a stack trace — rather than
    // reach the screen as a shortlist of nothing.
    const parsed = cookResponseSchema.safeParse({
      kind: "ranked",
      constraints,
      results: [],
      attempts: 1,
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a cards response carrying no rows", () => {
    // Not the same rule: `cards` promises safe rows and nothing about how many, and
    // `no_candidates` is what an empty candidate set returns long before this.
    const parsed = cookResponseSchema.safeParse({
      kind: "cards",
      constraints,
      results: [],
      reason: "ranking_unavailable",
    });

    expect(parsed.success).toBe(true);
  });
});
