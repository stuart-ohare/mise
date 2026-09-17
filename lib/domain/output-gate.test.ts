// @gate output
import { describe, expect, it, vi } from "vitest";

import { exclusionIds, type IngredientNode } from "./ingredient-tree";
import {
  collectStrings,
  outputTerms,
  runOutputGate,
  scanProse,
  type ScanHit,
  type ViolationRecord,
} from "./output-gate";
import { normaliseTerm } from "./resolve-exclusions";

const nodes: IngredientNode[] = [
  { id: "dairy", name: "dairy", parentId: null, allergenTags: ["dairy"] },
  { id: "butter", name: "butter", parentId: "dairy", allergenTags: [] },
  { id: "ghee", name: "ghee", parentId: "butter", allergenTags: [] },
  { id: "cream", name: "cream", parentId: "dairy", allergenTags: [] },
  { id: "double-cream", name: "double cream", parentId: "cream", allergenTags: [] },
  { id: "gluten", name: "gluten", parentId: null, allergenTags: ["gluten"] },
  { id: "wheat-flour", name: "wheat flour", parentId: "gluten", allergenTags: [] },
  { id: "soy", name: "soy", parentId: null, allergenTags: ["soy"] },
  { id: "soy-sauce", name: "soy sauce", parentId: "soy", allergenTags: ["gluten"] },
  { id: "veg", name: "vegetable", parentId: null, allergenTags: [] },
  { id: "tomato", name: "tomato", parentId: "veg", allergenTags: [] },
];

const aliases = [
  { canonicalId: "ghee", alias: "clarified butter" },
  { canonicalId: "double-cream", alias: "  Heavy  Cream " },
  { canonicalId: "soy-sauce", alias: "shoyu" },
  { canonicalId: "tomato", alias: "love apple" },
];

const dairyTerms = outputTerms(nodes, aliases, ["dairy"]);
const terms = (hits: ScanHit[]) => hits.map((hit) => hit.term);

describe("outputTerms", () => {
  it("includes a grandchild's name and aliases", () => {
    expect(dairyTerms).toContain("ghee");
    expect(dairyTerms).toContain("clarified butter");
  });

  it("includes ancestors but not siblings", () => {
    const butterTerms = outputTerms(nodes, aliases, ["butter"]);
    expect(butterTerms).toEqual(expect.arrayContaining(["butter", "ghee", "dairy"]));
    expect(butterTerms).not.toContain("cream");
  });

  it("includes cross-tree nodes carrying the root's tag", () => {
    const flourTerms = outputTerms(nodes, aliases, ["wheat-flour"]);
    expect(flourTerms).toEqual(expect.arrayContaining(["gluten", "soy sauce", "shoyu"]));
    expect(flourTerms).not.toContain("soy");
  });

  it("equals the names and aliases of exclusionIds", () => {
    for (const excluded of nodes.map((node) => node.id)) {
      const ids = exclusionIds(nodes, excluded);
      const expected = new Set([
        ...nodes.filter((node) => ids.has(node.id)).map((node) => normaliseTerm(node.name)),
        ...aliases.filter((a) => ids.has(a.canonicalId)).map((a) => normaliseTerm(a.alias)),
      ]);
      expect(new Set(outputTerms(nodes, aliases, [excluded]))).toEqual(expected);
    }
  });

  it("normalises, de-duplicates and combines several exclusions", () => {
    const combined = outputTerms(nodes, [...aliases, { canonicalId: "butter", alias: "BUTTER" }], [
      "double-cream",
      "tomato",
    ]);
    expect(combined).toContain("heavy cream");
    expect(combined).toContain("love apple");
    expect(combined.filter((term) => term === "cream")).toHaveLength(1);
    expect(combined).toEqual([...combined].sort());
  });
});

describe("scanProse", () => {
  it.each([
    ["finish with a knob of butter"],
    ["a buttery sauce"],
    ["butternut squash"],
  ])("prefix-matches from a word start: %s", (text) => {
    expect(terms(scanProse(text, dairyTerms))).toContain("butter");
  });

  it("does not parse negation", () => {
    expect(terms(scanProse("a dairy-free take", dairyTerms))).toContain("dairy");
    expect(terms(scanProse("no butter needed", dairyTerms))).toContain("butter");
  });

  it("matches multi-word terms across whitespace and case", () => {
    expect(terms(scanProse("Double  CREAM", dairyTerms))).toContain("double cream");
    expect(terms(scanProse("double\n\tcream", dairyTerms))).toContain("double cream");
    expect(terms(scanProse("BUTTER", dairyTerms))).toContain("butter");
  });

  it("treats a hyphen between words of a multi-word term as a separator", () => {
    expect(terms(scanProse("a clarified-butter finish", ["clarified butter"]))).toEqual([
      "clarified butter",
    ]);
  });

  it("returns no hits for a clean sentence", () => {
    expect(scanProse("a rich tomato stew", dairyTerms)).toEqual([]);
  });

  it("catches an excluded ingredient in an optional finishing line", () => {
    const prose =
      "Roast cauliflower. Quick, warming and on the table in 25 minutes. " +
      "If you like, finish with a little butter.";
    expect(terms(scanProse(prose, dairyTerms))).toContain("butter");
  });

  it("only matches from the start of a word", () => {
    // The spec's word-start rule, pinned so a fused compound is a visible choice.
    expect(scanProse("unbuttered toast", ["butter"])).toEqual([]);
  });

  it("escapes regex metacharacters in a term", () => {
    expect(scanProse("axb", ["a.b"])).toEqual([]);
    expect(terms(scanProse("a.b", ["a.b"]))).toEqual(["a.b"]);
  });

  it("reports the term, where it matched and the matched text", () => {
    expect(scanProse("Add the Buttery crumbs", ["butter"])).toEqual([
      { term: "butter", index: 8, match: "buttery" },
    ]);
  });
});

describe("collectStrings", () => {
  it("collects every string in a nested value", () => {
    expect(collectStrings({ a: "one", b: [{ c: "two" }, 3, null, "three"] })).toEqual([
      "one",
      "two",
      "three",
    ]);
  });
});

type Output = { items: { why: string }[]; closing: string };

const clean: Output = { items: [{ why: "bright and quick" }], closing: "enjoy" };
const leaky: Output = { items: [{ why: "finish with butter" }], closing: "enjoy" };
const scan = (output: Output) =>
  collectStrings(output).flatMap((text) => scanProse(text, dairyTerms));

function scripted(...outputs: (Output | Error)[]) {
  const generate = vi.fn(async (violatedTerms?: readonly string[]) => {
    void violatedTerms;
    const next = outputs.shift();
    if (next === undefined) throw new Error("generate called too many times");
    if (next instanceof Error) throw next;
    return next;
  });
  const records: ViolationRecord[] = [];
  const onViolation = vi.fn((record: ViolationRecord) => {
    records.push(record);
  });
  return { generate, onViolation, records };
}

describe("runOutputGate", () => {
  it("returns prose after one clean attempt", async () => {
    const { generate, onViolation } = scripted(clean);
    const result = await runOutputGate({ generate, scan, onViolation });

    expect(result).toEqual({ kind: "prose", output: clean, attempts: 1 });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith();
    expect(onViolation).not.toHaveBeenCalled();
  });

  it("retries once with the violated terms", async () => {
    const { generate, onViolation, records } = scripted(leaky, clean);
    const result = await runOutputGate({ generate, scan, onViolation });

    expect(result).toEqual({ kind: "prose", output: clean, attempts: 2 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenNthCalledWith(2, ["butter"]);
    expect(records).toEqual([
      {
        attempt: 1,
        matchedTerms: ["butter"],
        generated: JSON.stringify(leaky),
        retrySucceeded: true,
      },
    ]);
  });

  it("downgrades after two leaks", async () => {
    const { generate, onViolation, records } = scripted(leaky, leaky);
    const result = await runOutputGate({ generate, scan, onViolation });

    expect(result).toEqual({
      kind: "downgraded",
      violations: [
        { attempt: 1, matchedTerms: ["butter"] },
        { attempt: 2, matchedTerms: ["butter"] },
      ],
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(records.map((r) => [r.attempt, r.retrySucceeded])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  it("rejects a leak in a later nested string", async () => {
    const lateLeak: Output = {
      items: [{ why: "bright" }, { why: "quick" }],
      closing: "a knob of butter to finish",
    };
    const { generate, onViolation, records } = scripted(lateLeak, clean);
    const result = await runOutputGate({ generate, scan, onViolation });

    expect(result.kind).toBe("prose");
    expect(records).toHaveLength(1);
    expect(records[0]?.matchedTerms).toEqual(["butter"]);
  });

  it("still records a rejected attempt when the retry throws", async () => {
    const failure = new Error("schema parse failed");
    const { generate, onViolation, records } = scripted(leaky, failure);

    await expect(runOutputGate({ generate, scan, onViolation })).rejects.toBe(failure);
    expect(records).toEqual([
      {
        attempt: 1,
        matchedTerms: ["butter"],
        generated: JSON.stringify(leaky),
        retrySucceeded: false,
      },
    ]);
  });

  it("lets a failing first generate propagate without a gate event", async () => {
    const failure = new Error("network");
    const { generate, onViolation } = scripted(failure);

    await expect(runOutputGate({ generate, scan, onViolation })).rejects.toBe(failure);
    expect(onViolation).not.toHaveBeenCalled();
  });
});
