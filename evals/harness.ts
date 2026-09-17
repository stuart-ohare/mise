import { z } from "zod";

import type { ModelName } from "@/lib/ai/client";

export const GATES = ["resolution", "query", "output"] as const;

export type Thresholds = Readonly<Record<string, Readonly<Record<string, number>>>>;

export interface Suite<F> {
  name: string;
  prompt: { name: string; version: string };
  model: ModelName;
  fixtureSchema: z.ZodType<F>;
  run(fixtures: F[]): Promise<Record<string, number>>;
}

export type AnySuite = Suite<unknown>;

export function defineSuite<F>(suite: Suite<F>): AnySuite {
  return suite;
}

export const reportSchema = z.object({
  runAt: z.string(),
  gitSha: z.string(),
  passed: z.boolean(),
  suites: z.array(
    z.object({
      name: z.string(),
      prompt: z.object({ name: z.string(), version: z.string() }),
      model: z.string(),
      fixtures: z.number().int(),
      passed: z.boolean(),
      metrics: z.array(
        z.object({
          name: z.string(),
          value: z.number().nullable(),
          threshold: z.number().nullable(),
          passed: z.boolean(),
        }),
      ),
    }),
  ),
});

export interface RunOptions {
  suites: readonly AnySuite[];
  thresholds: Thresholds;
  fixturesRoot: string;
  reportPath: string;
  meta: { runAt: Date; gitSha: string };
  log: (line: string) => void;
}

export async function runEval(options: RunOptions): Promise<number> {
  void options;
  return 0;
}
