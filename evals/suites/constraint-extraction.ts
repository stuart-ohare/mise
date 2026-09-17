import { z } from "zod";

import type { ExtractionResult } from "@/lib/ai/prompts/extract-constraints";

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

export function scoreConstraintRuns(runs: readonly ScoredRun[]): Record<string, number> {
  void runs;
  throw new Error("not implemented");
}
