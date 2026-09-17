import { z } from "zod";

import { MODELS } from "@/lib/ai/client";
import { extractConstraints, VERSION, type ExtractionResult } from "@/lib/ai/prompts/extract-constraints";

import { defineSuite } from "../harness";
import { matchTerms, microF1, setExactMatch, type MatchCounts } from "../scorers";

/**
 * Call 1 against hand-written queries. Each fixture runs several times because the model
 * is non-deterministic and `exclude_exact` is held at 1: a prompt that is right most of
 * the time is not right.
 */

export const RUNS_PER_FIXTURE = 3;

// Several spellings of one ingredient (singular/plural), never different ingredients.
export const expectedTermSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(2)]);

export const constraintFixtureSchema = z.object({
  query: z.string().min(1),
  expected: z.object({
    exclude: z.array(expectedTermSchema),
    avoid: z.array(expectedTermSchema),
    have: z.array(expectedTermSchema),
    maxMinutes: z.number().int().positive().nullable(),
  }),
});

export type ConstraintFixture = z.infer<typeof constraintFixtureSchema>;

export interface ScoredRun {
  expected: ConstraintFixture["expected"];
  result: ExtractionResult;
}

/**
 * A failed run scores as a miss on `exclude` and `maxMinutes` even when nothing was
 * expected, and contributes no terms to F1: a failure is never a correct "no exclusions".
 */
export function scoreConstraintRuns(runs: readonly ScoredRun[]): Record<string, number> {
  const share = (hits: number) => (runs.length === 0 ? 0 : hits / runs.length);
  let excludeHits = 0;
  let minutesHits = 0;
  const avoid: MatchCounts[] = [];
  const have: MatchCounts[] = [];
  for (const { expected, result } of runs) {
    const actual = result.ok ? result.constraints : null;
    if (actual && setExactMatch(expected.exclude, actual.exclude)) excludeHits++;
    if (actual && actual.maxMinutes === expected.maxMinutes) minutesHits++;
    avoid.push(matchTerms(expected.avoid, actual?.avoid ?? []));
    have.push(matchTerms(expected.have, actual?.have ?? []));
  }
  return {
    exclude_exact: share(excludeHits),
    avoid_f1: microF1(avoid),
    have_f1: microF1(have),
    max_minutes_exact: share(minutesHits),
  };
}

export const constraintExtraction = defineSuite({
  name: "constraint-extraction",
  prompt: { name: "extract-constraints", version: VERSION },
  model: MODELS.fast,
  fixtureSchema: constraintFixtureSchema,
  async run(fixtures) {
    const runs: ScoredRun[] = [];
    for (const fixture of fixtures) {
      for (let i = 0; i < RUNS_PER_FIXTURE; i++) {
        const result = await extractConstraints(fixture.query);
        runs.push({ expected: fixture.expected, result });
        // The report holds only numbers; tuning the prompt needs to see which query missed.
        const score = scoreConstraintRuns([{ expected: fixture.expected, result }]);
        if (Object.values(score).some((value) => value < 1)) {
          console.error(
            `✗ ${JSON.stringify(fixture.query)} run ${i + 1}: expected ${JSON.stringify(fixture.expected)}, got ${JSON.stringify(result)}`,
          );
        }
      }
    }
    return scoreConstraintRuns(runs);
  },
});
