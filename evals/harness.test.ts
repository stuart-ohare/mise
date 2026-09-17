import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineSuite, reportSchema, runEval, type AnySuite, type Thresholds } from "./harness";

// The harness with stub suites: no model, no network. Fixtures and the report live in a
// fresh temp directory per case, so nothing touches evals/fixtures or evals/latest.md.

let dir: string;
let logs: string[];
let calls: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mise-eval-"));
  logs = [];
  calls = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const reportPath = () => join(dir, "latest.md");

function fixture(suite: string, file: string, content: unknown) {
  mkdirSync(join(dir, "fixtures", suite), { recursive: true });
  writeFileSync(join(dir, "fixtures", suite, file), JSON.stringify(content));
}

function stub(name: string, metrics: Record<string, number>, version = "1"): AnySuite {
  return defineSuite({
    name,
    prompt: { name: `${name}-prompt`, version },
    model: "claude-haiku-4-5",
    fixtureSchema: z.object({ query: z.string() }),
    async run(fixtures) {
      calls.push(`${name}:${fixtures.length}`);
      return metrics;
    },
  });
}

function run(suites: readonly AnySuite[], thresholds: Thresholds) {
  return runEval({
    suites,
    thresholds,
    fixturesRoot: join(dir, "fixtures"),
    reportPath: reportPath(),
    meta: { runAt: new Date("2026-09-17T12:00:00Z"), gitSha: "abc1234def" },
    log: (line) => logs.push(line),
  });
}

function reportJson() {
  const match = readFileSync(reportPath(), "utf8").match(/```json\n([\s\S]*?)\n```\s*$/);
  if (!match) throw new Error("report has no closing json block");
  return reportSchema.parse(JSON.parse(match[1]));
}

describe("runEval", () => {
  it("fails with no suites registered and writes no report", async () => {
    expect(await run([], {})).not.toBe(0);
    expect(logs.join("\n")).toContain("no suites registered");
    expect(existsSync(reportPath())).toBe(false);
  });

  it("passes when every metric meets its threshold, with a table and a parseable json block", async () => {
    fixture("constraints", "a.json", { gates: ["resolution"], query: "no dairy" });
    const code = await run([stub("constraints", { exclude: 1, have: 0.9 })], {
      constraints: { exclude: 1, have: 0.8 },
    });

    expect(code).toBe(0);
    const md = readFileSync(reportPath(), "utf8");
    expect(md).toMatch(/\|\s*exclude\s*\|\s*1\s*\|\s*1\s*\|\s*pass\s*\|/);
    expect(md).toMatch(/\|\s*have\s*\|\s*0\.9\s*\|\s*0\.8\s*\|\s*pass\s*\|/);
    const report = reportJson();
    expect(report.passed).toBe(true);
    expect(report.suites[0]).toMatchObject({ name: "constraints", fixtures: 1, passed: true });
    expect(calls).toEqual(["constraints:1"]);
  });

  it("fails below threshold but still writes the report, marking the metric failed", async () => {
    fixture("constraints", "a.json", { gates: ["resolution"], query: "no dairy" });
    const code = await run([stub("constraints", { exclude: 0.93, have: 0.9 })], {
      constraints: { exclude: 1, have: 0.8 },
    });

    expect(code).not.toBe(0);
    expect(readFileSync(reportPath(), "utf8")).toMatch(/\|\s*exclude\s*\|\s*0\.93\s*\|\s*1\s*\|\s*fail\s*\|/);
    const report = reportJson();
    expect(report.passed).toBe(false);
    expect(report.suites[0].passed).toBe(false);
    expect(report.suites[0].metrics).toContainEqual({ name: "exclude", value: 0.93, threshold: 1, passed: false });
    expect(report.suites[0].metrics).toContainEqual({ name: "have", value: 0.9, threshold: 0.8, passed: true });
  });

  it.each([
    ["missing gates", { query: "no dairy" }],
    ["an unknown gate", { gates: ["qurey"], query: "no dairy" }],
    ["an empty gates array", { gates: [], query: "no dairy" }],
    ["a field failing the suite's own schema", { gates: ["query"], query: 42 }],
  ])("fails a fixture with %s before any suite runs", async (_label, content) => {
    fixture("first", "ok.json", { gates: ["query"], query: "fine" });
    fixture("second", "bad.json", content);
    const code = await run([stub("first", { m: 1 }), stub("second", { m: 1 })], {
      first: { m: 1 },
      second: { m: 1 },
    });

    expect(code).not.toBe(0);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("bad.json");
    expect(existsSync(reportPath())).toBe(false);
  });

  it("fails a suite with no fixtures before any suite runs", async () => {
    fixture("first", "ok.json", { gates: ["query"], query: "fine" });
    const code = await run([stub("first", { m: 1 }), stub("empty", { m: 1 })], {
      first: { m: 1 },
      empty: { m: 1 },
    });

    expect(code).not.toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(reportPath())).toBe(false);
  });

  it("fails two suites with the same name", async () => {
    fixture("dup", "ok.json", { gates: ["query"], query: "fine" });
    const code = await run([stub("dup", { m: 1 }), stub("dup", { m: 1 })], { dup: { m: 1 } });

    expect(code).not.toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(reportPath())).toBe(false);
  });

  it("fails a fixture that isn't valid JSON before any suite runs", async () => {
    mkdirSync(join(dir, "fixtures", "constraints"), { recursive: true });
    writeFileSync(join(dir, "fixtures", "constraints", "broken.json"), '{ "gates": [');
    const code = await run([stub("constraints", { m: 1 })], { constraints: { m: 1 } });

    expect(code).not.toBe(0);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("broken.json");
    expect(existsSync(reportPath())).toBe(false);
  });

  it("aborts without a report when a suite throws", async () => {
    fixture("first", "a.json", { gates: ["query"], query: "fine" });
    fixture("second", "a.json", { gates: ["query"], query: "fine" });
    const throwing = defineSuite({
      name: "second",
      prompt: { name: "second-prompt", version: "1" },
      model: "claude-haiku-4-5",
      fixtureSchema: z.object({ query: z.string() }),
      async run() {
        throw new Error("model call failed");
      },
    });

    await expect(
      run([stub("first", { m: 1 }), throwing], { first: { m: 1 }, second: { m: 1 } }),
    ).rejects.toThrow("model call failed");
    expect(existsSync(reportPath())).toBe(false);
  });

  it.each([
    ["no thresholds entry", {}],
    ["an empty thresholds entry", { constraints: {} }],
  ])("fails a suite with %s before any suite runs", async (_label, thresholds: Thresholds) => {
    fixture("constraints", "a.json", { gates: ["resolution"], query: "no dairy" });
    // A suite returning no metrics against no thresholds would otherwise pass vacuously.
    const code = await run([stub("constraints", {})], thresholds);

    expect(code).not.toBe(0);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("constraints");
    expect(existsSync(reportPath())).toBe(false);
  });

  it("fails thresholds for a suite that isn't registered before any suite runs", async () => {
    fixture("safety", "a.json", { gates: ["output"], query: "something rich" });
    const code = await run([stub("safety", { m: 1 })], {
      safety: { m: 1 },
      constraints: { exclude: 1 },
    });

    expect(code).not.toBe(0);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("constraints");
    expect(existsSync(reportPath())).toBe(false);
  });

  it("fails a reported metric that has no threshold", async () => {
    fixture("constraints", "a.json", { gates: ["resolution"], query: "no dairy" });
    const code = await run([stub("constraints", { exclude: 1, extra: 1 })], {
      constraints: { exclude: 1 },
    });

    expect(code).not.toBe(0);
    const report = reportJson();
    expect(report.passed).toBe(false);
    expect(report.suites[0].metrics).toContainEqual({ name: "extra", value: 1, threshold: null, passed: false });
  });

  it("fails a threshold whose metric wasn't reported", async () => {
    fixture("constraints", "a.json", { gates: ["resolution"], query: "no dairy" });
    const code = await run([stub("constraints", { exclude: 1 })], {
      constraints: { exclude: 1, have: 0.8 },
    });

    expect(code).not.toBe(0);
    const report = reportJson();
    expect(report.passed).toBe(false);
    expect(report.suites[0].metrics).toContainEqual({ name: "have", value: null, threshold: 0.8, passed: false });
  });

  it("names the run time, git sha, and each suite's prompt, version and model in the header", async () => {
    fixture("constraints", "a.json", { gates: ["resolution"], query: "no dairy" });
    fixture("safety", "a.json", { gates: ["output"], query: "something rich" });
    await run([stub("constraints", { m: 1 }, "3"), stub("safety", { m: 1 }, "7")], {
      constraints: { m: 1 },
      safety: { m: 1 },
    });

    const md = readFileSync(reportPath(), "utf8");
    const header = md.slice(0, md.indexOf("|"));
    expect(header).toContain("2026-09-17T12:00:00.000Z");
    expect(header).toContain("abc1234def");
    expect(header).toMatch(/constraints-prompt.*v3.*claude-haiku-4-5/);
    expect(header).toMatch(/safety-prompt.*v7.*claude-haiku-4-5/);
    expect(reportJson().suites.map((s) => s.prompt)).toEqual([
      { name: "constraints-prompt", version: "3" },
      { name: "safety-prompt", version: "7" },
    ]);
  });
});
