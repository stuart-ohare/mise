import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { config } from "dotenv";

import { runEval } from "./harness";
import { suites } from "./suites";
import { thresholds } from "./thresholds";

/**
 * `pnpm eval`: runs every registered suite against the real model and writes
 * `evals/latest.md`. Costs money and is non-deterministic — run on demand, never in
 * CI (ADR 0003).
 */

config({ path: ".env.local", quiet: true });

const root = resolve(__dirname, "..");

runEval({
  suites,
  thresholds,
  fixturesRoot: resolve(root, "evals/fixtures"),
  reportPath: resolve(root, "evals/latest.md"),
  meta: {
    runAt: new Date(),
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  },
  log: (line) => console.log(line),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error("✗ eval run aborted — no report written:", error);
    process.exitCode = 1;
  },
);
