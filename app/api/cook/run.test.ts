import { describe, expect, it } from "vitest";

import { MAX_RESULTS } from "@/lib/ai/prompts/rank-and-explain";
import type { CandidateRecipe } from "@/lib/db/candidates";
import type { IngredientTree } from "@/lib/db/ingredients";
import type { ResolutionTerm } from "@/lib/db/terms";
import type { Constraints } from "@/lib/domain/constraints";

import { runCook, type CookDeps, type ViolationSinkRecord } from "./run";
import { cookResponseSchema } from "./schema";

/**
 * The route's own tests: every gate is correct before this file, so what is asserted
 * here is the wiring. Offline — no database, no network — because the interesting
 * failures are which arguments each gate receives, not whether Postgres works.
 */

const DAIRY = "11111111-1111-4111-8111-111111111111";
const WHEAT = "22222222-2222-4222-8222-222222222222";
const GHEE = "33333333-3333-4333-8333-333333333333";

const TERMS: ResolutionTerm[] = [
  { term: "dairy", canonicalId: DAIRY },
  { term: "wheat", canonicalId: WHEAT },
  { term: "butter", canonicalId: DAIRY },
];

/** `ghee` hangs off dairy, so excluding dairy must make "ghee" a word prose can't use. */
const TREE: IngredientTree = {
  nodes: [
    { id: DAIRY, name: "dairy", parentId: null, allergenTags: ["dairy"] },
    { id: GHEE, name: "ghee", parentId: DAIRY, allergenTags: [] },
    { id: WHEAT, name: "wheat", parentId: null, allergenTags: ["gluten"] },
  ],
  aliases: [{ canonicalId: GHEE, alias: "clarified butter" }],
};

function constraints(over: Partial<Constraints> = {}): Constraints {
  return { exclude: [], avoid: [], have: [], maxMinutes: null, ...over };
}

function recipe(id: string, over: Partial<CandidateRecipe> = {}): CandidateRecipe {
  return { id, title: `Recipe ${id}`, summary: null, minutes: 20, serves: 2, ...over };
}

const ROW_A = recipe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const ROW_B = recipe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const ROW_C = recipe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");

type Calls = {
  extract: string[];
  findCandidates: string[][];
  loadIngredients: string[][];
  rank: { ids: string[]; violatedTerms: readonly string[] | undefined }[];
  violations: ViolationSinkRecord[];
};

type Harness = { deps: CookDeps; calls: Calls };

/**
 * Fakes that record what they were handed. `rank` takes a queue: one entry per attempt,
 * so a test can make attempt 1 violate and attempt 2 clean.
 */
function harness(opts: {
  extract?: CookDeps["extract"];
  terms?: ResolutionTerm[];
  tree?: IngredientTree;
  rows?: CandidateRecipe[];
  ingredients?: Map<string, string[]>;
  rankQueue?: Awaited<ReturnType<CookDeps["rank"]>>[];
}): Harness {
  const calls: Calls = {
    extract: [],
    findCandidates: [],
    loadIngredients: [],
    rank: [],
    violations: [],
  };
  const queue = [...(opts.rankQueue ?? [])];

  return {
    calls,
    deps: {
      extract: async (query) => {
        calls.extract.push(query);
        return opts.extract
          ? opts.extract(query)
          : { ok: true as const, constraints: constraints() };
      },
      loadTerms: async () => opts.terms ?? TERMS,
      loadTree: async () => opts.tree ?? TREE,
      findCandidates: async (excludedIds) => {
        calls.findCandidates.push([...excludedIds]);
        return opts.rows ?? [];
      },
      loadIngredients: async (recipeIds) => {
        calls.loadIngredients.push([...recipeIds]);
        return opts.ingredients ?? new Map();
      },
      rank: async (input, violatedTerms) => {
        calls.rank.push({ ids: input.candidates.map((c) => c.id), violatedTerms });
        // Degrades rather than throws: a test that expected no call at all should fail
        // on its own assertion about `calls.rank`, not on an exception from the fake.
        return queue.shift() ?? { ok: false, reason: "no_candidates" };
      },
      recordViolation: async (record) => {
        calls.violations.push(record);
      },
    },
  };
}

const ranking = (...entries: [string, string][]) => ({
  ok: true as const,
  ranking: entries.map(([id, rationale]) => ({ id, rationale })),
});

describe("runCook", () => {
  it("ranks the rows gate 2 returned and attaches each rationale", async () => {
    const { deps } = harness({
      rows: [ROW_A, ROW_B],
      rankQueue: [ranking([ROW_B.id, "Quick and uses the cauliflower"], [ROW_A.id, "Also good"])],
    });

    const result = await runCook({ kind: "query", query: "something quick" }, deps);

    expect(result.kind).toBe("ranked");
    if (result.kind !== "ranked") return;
    expect(result.results.map((r) => r.recipe.id)).toEqual([ROW_B.id, ROW_A.id]);
    expect(result.results[0]?.rationale).toBe("Quick and uses the cauliflower");
    expect(result.attempts).toBe(1);
    expect(cookResponseSchema.parse(result)).toEqual(result);
  });

  // @gate resolution
  it("returns no rows when an exclusion does not resolve, and queries nothing", async () => {
    const { deps, calls } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ exclude: ["ghee"] }) }),
      rows: [ROW_A],
      rankQueue: [ranking([ROW_A.id, "fine"])],
    });

    const result = await runCook({ kind: "query", query: "no ghee please" }, deps);

    expect(result).toEqual({
      kind: "needs_resolution",
      constraints: constraints({ exclude: ["ghee"] }),
      unresolved: ["ghee"],
    });
    // The assertion that matters: a pipeline that queried anyway and discarded the rows
    // would satisfy the shape above while having applied no exclusion at all.
    expect(calls.findCandidates).toEqual([]);
    expect(calls.rank).toEqual([]);
  });

  // @gate resolution
  it("reports every unresolved term, not just the first", async () => {
    const { deps } = harness({
      extract: async () => ({
        ok: true,
        constraints: constraints({ exclude: ["ghee", "dairy", "kohlrabi"] }),
      }),
    });

    const result = await runCook({ kind: "query", query: "no ghee, dairy or kohlrabi" }, deps);

    expect(result.kind).toBe("needs_resolution");
    if (result.kind !== "needs_resolution") return;
    expect(result.unresolved).toEqual(["ghee", "kohlrabi"]);
  });

  // @gate query
  it("hands gate 2 exactly the ids gate 1 resolved", async () => {
    const { deps, calls } = harness({
      extract: async () => ({
        ok: true,
        constraints: constraints({ exclude: ["Dairy", "wheat"] }),
      }),
      rows: [ROW_A],
      rankQueue: [ranking([ROW_A.id, "fine"])],
    });

    await runCook({ kind: "query", query: "no dairy, no wheat" }, deps);

    // Canonical ids, in order: not the raw terms, and nothing widened here — the
    // ancestors and cross-tree tags are gate 2's own SQL to compute.
    expect(calls.findCandidates).toEqual([[DAIRY, WHEAT]]);
  });

  // @gate query
  it("asks for ingredient names only for the rows gate 2 returned", async () => {
    const { deps, calls } = harness({
      rows: [ROW_A, ROW_C],
      ingredients: new Map([[ROW_A.id, ["onion", "lentils"]]]),
      rankQueue: [ranking([ROW_A.id, "fine"])],
    });

    await runCook({ kind: "query", query: "dinner" }, deps);

    expect(calls.loadIngredients).toEqual([[ROW_A.id, ROW_C.id]]);
    expect(calls.rank[0]?.ids).toEqual([ROW_A.id, ROW_C.id]);
  });

  // @gate output
  it("retries once when prose names an excluded food, and never renders the first attempt", async () => {
    const { deps, calls } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ exclude: ["dairy"] }) }),
      rows: [ROW_A],
      rankQueue: [
        ranking([ROW_A.id, "Finish with a spoon of ghee"]),
        ranking([ROW_A.id, "Deeply savoury and ready fast"]),
      ],
    });

    const result = await runCook({ kind: "query", query: "no dairy" }, deps);

    expect(result.kind).toBe("ranked");
    if (result.kind !== "ranked") return;
    expect(result.attempts).toBe(2);
    expect(result.results[0]?.rationale).toBe("Deeply savoury and ready fast");
    expect(JSON.stringify(result)).not.toContain("ghee");
    // The retry has to say which word was wrong, or it is just a second roll of the dice.
    expect(calls.rank[1]?.violatedTerms).toContain("ghee");
    expect(calls.rank[0]?.violatedTerms).toBeUndefined();
  });

  // @gate output
  it("scans the aliases of an excluded food, not just its name", async () => {
    const { deps } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ exclude: ["dairy"] }) }),
      rows: [ROW_A],
      rankQueue: [
        ranking([ROW_A.id, "Rich with clarified butter"]),
        ranking([ROW_A.id, "Rich and quick"]),
      ],
    });

    const result = await runCook({ kind: "query", query: "no dairy" }, deps);

    expect(result.kind).toBe("ranked");
    if (result.kind !== "ranked") return;
    expect(result.attempts).toBe(2);
  });

  // @gate output
  it("downgrades to cards when both attempts name an excluded food", async () => {
    const { deps, calls } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ exclude: ["dairy"] }) }),
      rows: [ROW_A, ROW_B],
      rankQueue: [
        ranking([ROW_A.id, "Stir in the ghee"]),
        ranking([ROW_A.id, "Still has ghee in it"]),
      ],
    });

    const result = await runCook({ kind: "query", query: "no dairy" }, deps);

    expect(result.kind).toBe("cards");
    if (result.kind !== "cards") return;
    expect(result.reason).toBe("output_violation");
    expect(result.results.map((r) => r.id)).toEqual([ROW_A.id, ROW_B.id]);
    // No rationale key anywhere: the downgraded variant carries no generated text at all.
    expect(JSON.stringify(result)).not.toContain("rationale");
    expect(JSON.stringify(result)).not.toContain("ghee");
    expect(calls.violations.map((v) => [v.attempt, v.retrySucceeded])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  // @gate output
  it("records the rejected prose and the query for each violating attempt", async () => {
    const { deps, calls } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ exclude: ["dairy"] }) }),
      rows: [ROW_A],
      rankQueue: [
        ranking([ROW_A.id, "Stir in the ghee"]),
        ranking([ROW_A.id, "Ghee again, sorry"]),
      ],
    });

    await runCook({ kind: "query", query: "no dairy at all" }, deps);

    const [first, second] = calls.violations;
    expect(first?.matchedTerms).toContain("ghee");
    expect(first?.generated).toContain("Stir in the ghee");
    expect(first?.query).toBe("no dairy at all");
    expect(first?.constraints.exclude).toEqual(["dairy"]);
    expect(second?.attempt).toBe(2);
  });

  it("records the retry's success against the first attempt", async () => {
    const { deps, calls } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ exclude: ["dairy"] }) }),
      rows: [ROW_A],
      rankQueue: [ranking([ROW_A.id, "With ghee"]), ranking([ROW_A.id, "Clean"])],
    });

    await runCook({ kind: "query", query: "no dairy" }, deps);

    expect(calls.violations).toHaveLength(1);
    expect(calls.violations[0]).toMatchObject({ attempt: 1, retrySucceeded: true });
  });

  it("does not record a retry that never wrote a sentence as a success", async () => {
    const { deps, calls } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ exclude: ["dairy"] }) }),
      rows: [ROW_A],
      rankQueue: [ranking([ROW_A.id, "Stir in the ghee"]), { ok: false, reason: "api_error" }],
    });

    const result = await runCook({ kind: "query", query: "no dairy" }, deps);

    // A failed call 3 has no prose, so it scans clean. That must not read as the gate
    // having been satisfied — output_violation is the evidence the gate is load-bearing.
    expect(calls.violations[0]).toMatchObject({ attempt: 1, retrySucceeded: false });
    expect(result).toMatchObject({ kind: "cards", reason: "ranking_unavailable" });
  });

  it("does not treat a recipe id as prose to scan", async () => {
    // "beef" is four hex characters, so a uuid segment can begin with it. scanProse
    // matches at a word start and treats "-" as a boundary, so scanning the ids would
    // reject this response for a food no rationale mentions.
    const beefy = recipe("beef1234-0000-4000-8000-000000000000");
    const { deps, calls } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ exclude: ["beef"] }) }),
      terms: [{ term: "beef", canonicalId: DAIRY }],
      tree: { nodes: [{ id: DAIRY, name: "beef", parentId: null, allergenTags: [] }], aliases: [] },
      rows: [beefy],
      rankQueue: [ranking([beefy.id, "A bright, herby plate of vegetables"])],
    });

    const result = await runCook({ kind: "query", query: "no beef" }, deps);

    expect(result.kind).toBe("ranked");
    expect(calls.rank).toHaveLength(1);
    expect(calls.violations).toEqual([]);
  });

  it("returns cards when call 3 fails outright", async () => {
    const { deps, calls } = harness({
      rows: [ROW_A],
      rankQueue: [{ ok: false, reason: "api_error" }],
    });

    const result = await runCook({ kind: "query", query: "dinner" }, deps);

    expect(result.kind).toBe("cards");
    if (result.kind !== "cards") return;
    expect(result.reason).toBe("ranking_unavailable");
    // An API error is not a gate event, and must not burn the retry.
    expect(calls.rank).toHaveLength(1);
    expect(calls.violations).toEqual([]);
  });

  it("returns cards when call 3 invents every id", async () => {
    const { deps } = harness({ rows: [ROW_A], rankQueue: [{ ok: false, reason: "no_valid_ids" }] });

    const result = await runCook({ kind: "query", query: "dinner" }, deps);

    expect(result.kind).toBe("cards");
    if (result.kind !== "cards") return;
    expect(result.reason).toBe("ranking_unavailable");
  });

  it("sorts and caps unranked cards so the list is deterministic", async () => {
    const rows = [
      recipe("dddddddd-dddd-4ddd-8ddd-dddddddddddd", { minutes: null, title: "Nulls last" }),
      recipe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { minutes: 40, title: "Slow" }),
      recipe("ffffffff-ffff-4fff-8fff-ffffffffffff", { minutes: 10, title: "Fast" }),
      recipe("a1111111-1111-4111-8111-111111111111", { minutes: 10, title: "Also fast" }),
      recipe("a2222222-2222-4222-8222-222222222222", { minutes: 15, title: "Middling" }),
      recipe("a3333333-3333-4333-8333-333333333333", { minutes: 30, title: "Longer" }),
    ];
    const { deps } = harness({ rows, rankQueue: [{ ok: false, reason: "api_error" }] });

    const result = await runCook({ kind: "query", query: "dinner" }, deps);

    expect(result.kind).toBe("cards");
    if (result.kind !== "cards") return;
    expect(result.results).toHaveLength(MAX_RESULTS);
    expect(result.results.map((r) => r.title)).toEqual([
      "Also fast",
      "Fast",
      "Middling",
      "Longer",
      "Slow",
    ]);
  });

  it("keeps a recipe over the time limit out of the ranking", async () => {
    const quick = recipe("a4444444-4444-4444-8444-444444444444", { minutes: 20 });
    const slow = recipe("a5555555-5555-4555-8555-555555555555", { minutes: 45 });
    const { deps, calls } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ maxMinutes: 25 }) }),
      rows: [quick, slow],
      rankQueue: [ranking([quick.id, "Ready in twenty"])],
    });

    const result = await runCook({ kind: "query", query: "25 minutes" }, deps);

    expect(calls.rank[0]?.ids).toEqual([quick.id]);
    expect(result.kind).toBe("ranked");
  });

  it("treats an unknown cooking time as over the limit", async () => {
    const unknown = recipe("a6666666-6666-4666-8666-666666666666", { minutes: null });
    const { deps, calls } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ maxMinutes: 25 }) }),
      rows: [unknown],
      rankQueue: [],
    });

    const result = await runCook({ kind: "query", query: "25 minutes" }, deps);

    // An unstated time is not a promise that it fits.
    expect(calls.rank).toEqual([]);
    expect(result).toMatchObject({
      kind: "no_candidates",
      relaxTime: { limit: 25, wouldMatch: 1 },
    });
  });

  it("offers the time limit back when relaxing it would help", async () => {
    const rows = [
      recipe("a7777777-7777-4777-8777-777777777777", { minutes: 40 }),
      recipe("a8888888-8888-4888-8888-888888888888", { minutes: 50 }),
    ];
    const { deps } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ maxMinutes: 25 }) }),
      rows,
      rankQueue: [],
    });

    const result = await runCook({ kind: "query", query: "in 25 minutes" }, deps);

    expect(result).toMatchObject({
      kind: "no_candidates",
      relaxTime: { limit: 25, wouldMatch: 2 },
    });
  });

  it("offers nothing back when the candidate set is empty for another reason", async () => {
    const { deps } = harness({
      extract: async () => ({ ok: true, constraints: constraints({ maxMinutes: 25 }) }),
      rows: [],
      rankQueue: [],
    });

    const result = await runCook({ kind: "query", query: "in 25 minutes" }, deps);

    // There is nothing to relax toward, so offering to relax would be a lie.
    expect(result).toMatchObject({ kind: "no_candidates", relaxTime: null });
  });

  it("reports no candidates without a time limit as no candidates", async () => {
    const { deps, calls } = harness({ rows: [], rankQueue: [] });

    const result = await runCook({ kind: "query", query: "dinner" }, deps);

    expect(result).toMatchObject({ kind: "no_candidates", relaxTime: null });
    expect(calls.rank).toEqual([]);
  });

  it("skips extraction when the request already carries constraints", async () => {
    const edited = constraints({ exclude: ["wheat"], avoid: ["dairy"] });
    const { deps, calls } = harness({
      rows: [ROW_A],
      rankQueue: [ranking([ROW_A.id, "fine"])],
    });

    const result = await runCook({ kind: "constraints", constraints: edited }, deps);

    expect(calls.extract).toEqual([]);
    // A demoted exclusion still filters on what remains hard, and only on that.
    expect(calls.findCandidates).toEqual([[WHEAT]]);
    expect(result.kind).toBe("ranked");
  });

  it("resolves and filters a client-supplied exclusion like an extracted one", async () => {
    const { deps, calls } = harness({
      rows: [ROW_A],
      rankQueue: [ranking([ROW_A.id, "fine"])],
    });

    await runCook({ kind: "constraints", constraints: constraints({ exclude: ["butter"] }) }, deps);

    expect(calls.findCandidates).toEqual([[DAIRY]]);
  });

  it("does not resolve an unresolvable client-supplied exclusion", async () => {
    const { deps, calls } = harness({});

    const result = await runCook(
      { kind: "constraints", constraints: constraints({ exclude: ["ghee"] }) },
      deps,
    );

    expect(result.kind).toBe("needs_resolution");
    expect(calls.findCandidates).toEqual([]);
  });

  it("returns not_understood for a blank query without calling the model", async () => {
    const { deps, calls } = harness({
      extract: async () => ({ ok: false, reason: "empty_query" }),
    });

    const result = await runCook({ kind: "query", query: "   " }, deps);

    expect(result).toEqual({ kind: "not_understood", reason: "empty_query" });
    expect(calls.findCandidates).toEqual([]);
    expect(calls.rank).toEqual([]);
  });

  it.each(["refused", "parse_failed", "api_error"] as const)(
    "returns not_understood when extraction fails with %s",
    async (reason) => {
      const { deps, calls } = harness({ extract: async () => ({ ok: false, reason }) });

      const result = await runCook({ kind: "query", query: "dinner" }, deps);

      expect(result).toEqual({ kind: "not_understood", reason });
      expect(calls.findCandidates).toEqual([]);
    },
  );

  it("returns a response the shared schema accepts, whatever the outcome", async () => {
    const cases: Promise<unknown>[] = [
      runCook({ kind: "query", query: "dinner" }, harness({ rows: [], rankQueue: [] }).deps),
      runCook(
        { kind: "constraints", constraints: constraints({ exclude: ["ghee"] }) },
        harness({}).deps,
      ),
      runCook(
        { kind: "query", query: "dinner" },
        harness({ rows: [ROW_A], rankQueue: [{ ok: false, reason: "api_error" }] }).deps,
      ),
    ];

    for (const pending of cases) {
      const response = await pending;
      expect(() => cookResponseSchema.parse(response)).not.toThrow();
    }
  });
});
