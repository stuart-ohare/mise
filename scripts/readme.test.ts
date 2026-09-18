import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { RUNS_PER_FIXTURE as CONSTRAINT_RUNS } from "../evals/suites/constraint-extraction";
import { RUNS_PER_FIXTURE as RECIPE_RUNS } from "../evals/suites/recipe-extraction";

// The README is what a reviewer reads first, and its numbers and links drift silently:
// a fixture gets added, a trade-off gets written, and the prose still says the old
// count. Every number asserted here is one the README states as fact.

const ROOT = resolve(__dirname, "..");
const README = readFileSync(resolve(ROOT, "README.md"), "utf8");
// Prose wraps at ~88 columns, so a phrase can straddle a line break — inside the TL;DR's
// blockquote, a `>` too.
const PROSE = README.replace(/^>[ \t]?/gm, "").replace(/\s+/g, " ");

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function withoutCodeFences(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```/gm, "");
}

// GitHub's heading anchors: lowercase, drop punctuation other than hyphens, spaces to hyphens.
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- ]/gu, "")
    .replace(/ /g, "-");
}

function headings(markdown: string): string[] {
  return withoutCodeFences(markdown)
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => line.replace(/^#+ /, ""));
}

function links(markdown: string): string[] {
  return [...withoutCodeFences(markdown).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "");
}

function stated(pattern: RegExp): number {
  const match = pattern.exec(PROSE);
  if (!match?.[1]) throw new Error(`README no longer states ${pattern}`);
  const value = match[1].toLowerCase();
  return WORDS.includes(value) ? WORDS.indexOf(value) : Number(value);
}

function countJson(dir: string): number {
  return readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith(".json")).length;
}

type SeedNode = { name: string; parent: string | null };
function seedNodes(file: string): SeedNode[] {
  return (JSON.parse(readFileSync(resolve(ROOT, "scripts/seed", file), "utf8")) as { nodes: SeedNode[] }).nodes;
}

describe("README links", () => {
  it("points every relative link at a file that exists", () => {
    const missing = links(README)
      .filter((href) => !/^(https?:|mailto:|#)/.test(href))
      .map((href) => href.split("#")[0] ?? "")
      .filter((path) => !existsSync(resolve(dirname(resolve(ROOT, "README.md")), path)));
    expect(missing).toEqual([]);
  });

  it("points every in-page anchor at a heading", () => {
    const anchors = new Set(headings(README).map(slug));
    const dangling = links(README)
      .filter((href) => href.startsWith("#"))
      .map((href) => href.slice(1))
      .filter((anchor) => !anchors.has(anchor));
    expect(dangling).toEqual([]);
  });
});

describe("README counts", () => {
  it("names as many trade-offs as the section has", () => {
    const section = /^## Trade-offs\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(withoutCodeFences(README))?.[1] ?? "";
    const written = section.split("\n").filter((line) => line.startsWith("### ")).length;
    expect(stated(/(\w+) decisions that shaped what is here/i)).toBe(written);
  });

  it("states the eval suite's fixture and call counts", () => {
    const constraint = countJson("evals/fixtures/constraint-extraction");
    const recipe = countJson("evals/fixtures/recipe-extraction");

    expect(stated(/constraint extraction \((\d+) fixtures\)/)).toBe(constraint);
    expect(stated(/recipe extraction \((\d+) sources\)/)).toBe(recipe);
    expect(stated(/(\d+) constraint fixtures and \d+ recipe sources/)).toBe(constraint);
    expect(stated(/\d+ constraint fixtures and (\d+) recipe sources/)).toBe(recipe);
    expect(stated(/The real model on (\d+) fixtures/)).toBe(constraint + recipe);
    expect(stated(/one run is (\d+) calls/)).toBe(constraint * CONSTRAINT_RUNS + recipe * RECIPE_RUNS);
    expect(stated(/(\d+) runs each/)).toBe(CONSTRAINT_RUNS);
    expect(RECIPE_RUNS).toBe(CONSTRAINT_RUNS);
  });

  it("states the seed catalogue's size", () => {
    const tree = seedNodes("taxonomy.json");
    const leaves = seedNodes("leaves.json");
    const treeNames = new Set(tree.map((n) => n.name));
    const underTree = leaves.filter((l) => l.parent !== null && treeNames.has(l.parent)).length;
    const recipes = (JSON.parse(readFileSync(resolve(ROOT, "scripts/seed/recipes.json"), "utf8")) as { recipes: unknown[] }).recipes.length;

    expect(stated(/The (\d+) nodes of the allergen hierarchy/)).toBe(tree.length);
    expect(stated(/the (\d+) leaves and \d+ recipes/)).toBe(leaves.length);
    expect(stated(/the \d+ leaves and (\d+) recipes/)).toBe(recipes);
    expect(stated(/Only (\d+) of those leaves hang under/)).toBe(underTree);
    expect(stated(/the other (\d+) stand outside the tree/)).toBe(leaves.length - underTree);
  });
});
