import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { ModelName } from "@/lib/ai/client";

/**
 * The eval harness: loads fixtures, runs suites, checks every metric against
 * `evals/thresholds.ts`, and writes `evals/latest.md`. It never calls a model — suites
 * do — so it is tested offline with stub suites.
 */

export const GATES = ["resolution", "query", "output"] as const;

/** suite name → metric name → minimum passing value. */
export type Thresholds = Readonly<Record<string, Readonly<Record<string, number>>>>;

export interface Suite<F> {
  /** Also the fixture directory name and the key in `thresholds`. */
  name: string;
  /** The prompt under test, so a report can be tied to the text that produced it (§4.6). */
  prompt: { name: string; version: string };
  model: ModelName;
  /** The suite's own fields. `gates` is checked by the harness before this runs. */
  fixtureSchema: z.ZodType<F>;
  // Method syntax, not a property: keeps Suite<F> assignable to AnySuite.
  run(fixtures: F[]): Promise<Record<string, number>>;
}

export type AnySuite = Suite<unknown>;

export function defineSuite<F>(suite: Suite<F>): AnySuite {
  return suite;
}

const fixtureBaseSchema = z.object({ gates: z.array(z.enum(GATES)).min(1) });

const metricResultSchema = z.object({
  name: z.string(),
  value: z.number().nullable(),
  threshold: z.number().nullable(),
  passed: z.boolean(),
});

/** The closing JSON block of `latest.md`. Checks on the report (#13) parse this, not the tables. */
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
      metrics: z.array(metricResultSchema),
    }),
  ),
});

export type Report = z.infer<typeof reportSchema>;
type MetricResult = z.infer<typeof metricResultSchema>;

export interface RunOptions {
  suites: readonly AnySuite[];
  thresholds: Thresholds;
  fixturesRoot: string;
  reportPath: string;
  meta: { runAt: Date; gitSha: string };
  log: (line: string) => void;
}

/** Returns the process exit code: 0 only when every suite ran and every metric passed. */
export async function runEval(options: RunOptions): Promise<number> {
  const { suites, thresholds, fixturesRoot, reportPath, meta, log } = options;

  if (suites.length === 0) {
    log("✗ no suites registered — nothing to evaluate, so no report is written");
    return 1;
  }

  const names = suites.map((s) => s.name);
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicates.length > 0) {
    log(`✗ duplicate suite names: ${[...new Set(duplicates)].join(", ")}`);
    return 1;
  }

  // Every fixture for every suite parses before any suite runs: a bad fixture found
  // halfway through would leave a partial run that has already spent money.
  const loaded: unknown[][] = [];
  const errors: string[] = [];
  for (const suite of suites) {
    const result = loadFixtures(suite, fixturesRoot);
    if (result.ok) loaded.push(result.fixtures);
    else errors.push(...result.errors);
  }
  if (errors.length > 0) {
    for (const error of errors) log(`✗ ${error}`);
    return 1;
  }

  const results: Report["suites"] = [];
  for (const [i, suite] of suites.entries()) {
    const fixtures = loaded[i];
    const metrics = checkMetrics(await suite.run(fixtures), thresholds[suite.name] ?? {});
    results.push({
      name: suite.name,
      prompt: suite.prompt,
      model: suite.model,
      fixtures: fixtures.length,
      passed: metrics.every((m) => m.passed),
      metrics,
    });
  }

  const report: Report = {
    runAt: meta.runAt.toISOString(),
    gitSha: meta.gitSha,
    passed: results.every((s) => s.passed),
    suites: results,
  };
  const markdown = renderReport(report);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, markdown);
  log(markdown);

  return report.passed ? 0 : 1;
}

function loadFixtures(
  suite: AnySuite,
  fixturesRoot: string,
): { ok: true; fixtures: unknown[] } | { ok: false; errors: string[] } {
  const dir = join(fixturesRoot, suite.name);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    files = [];
  }
  // A metric computed over no fixtures passes vacuously.
  if (files.length === 0) return { ok: false, errors: [`suite ${suite.name} has no fixtures in ${dir}`] };

  const fixtures: unknown[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const path = join(dir, file);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      errors.push(`${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const base = fixtureBaseSchema.safeParse(json);
    const own = suite.fixtureSchema.safeParse(json);
    if (!base.success) errors.push(`${path}: ${z.prettifyError(base.error)}`);
    if (!own.success) errors.push(`${path}: ${z.prettifyError(own.error)}`);
    if (base.success && own.success) fixtures.push(own.data);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, fixtures };
}

/** Every reported metric needs a threshold and every threshold a reported metric. */
function checkMetrics(
  reported: Readonly<Record<string, number>>,
  thresholds: Readonly<Record<string, number>>,
): MetricResult[] {
  const names = [...new Set([...Object.keys(reported), ...Object.keys(thresholds)])];
  return names.map((name) => {
    const value = Object.hasOwn(reported, name) ? reported[name] : null;
    const threshold = Object.hasOwn(thresholds, name) ? thresholds[name] : null;
    return { name, value, threshold, passed: value !== null && threshold !== null && value >= threshold };
  });
}

export function renderReport(report: Report): string {
  const lines = [
    "# Eval report",
    "",
    `- **Result:** ${report.passed ? "pass" : "fail"}`,
    `- **Run at:** ${report.runAt}`,
    `- **Commit:** ${report.gitSha}`,
    "",
    "## Prompts",
    "",
    ...report.suites.map((s) => `- \`${s.name}\`: ${s.prompt.name} v${s.prompt.version} on ${s.model}`),
  ];
  for (const suite of report.suites) {
    lines.push(
      "",
      `## ${suite.name} — ${suite.passed ? "pass" : "fail"} (${suite.fixtures} fixtures)`,
      "",
      "| Metric | Value | Threshold | Result |",
      "|---|---|---|---|",
      ...suite.metrics.map(
        (m) => `| ${m.name} | ${m.value ?? "missing"} | ${m.threshold ?? "missing"} | ${m.passed ? "pass" : "fail"} |`,
      ),
    );
  }
  lines.push("", "```json", JSON.stringify(report, null, 2), "```", "");
  return lines.join("\n");
}
