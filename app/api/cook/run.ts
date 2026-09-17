import type { ExtractionResult } from "@/lib/ai/prompts/extract-constraints";
import {
  MAX_RESULTS,
  VERSION as RANKING_VERSION,
  type RankingCandidate,
  type RankingInput,
  type RankingResult,
} from "@/lib/ai/prompts/rank-and-explain";
import type { CandidateRecipe } from "@/lib/db/candidates";
import type { IngredientTree } from "@/lib/db/ingredients";
import type { ResolutionTerm } from "@/lib/db/terms";
import type { Constraints } from "@/lib/domain/constraints";
import {
  collectStrings,
  outputTerms,
  runOutputGate,
  scanProse,
  type ViolationRecord,
} from "@/lib/domain/output-gate";
import { buildResolutionIndex, resolveExclusions } from "@/lib/domain/resolve-exclusions";

import type { CookRequest, CookResponse } from "./schema";

/**
 * The Cook pipeline: constraint extraction → gate 1 → gate 2 → call 3 under gate 3.
 *
 * Each gate is already correct on its own. This is the one place a wiring slip defeats a
 * correct gate — the wrong ids into gate 2, the wrong terms into gate 3, or rows
 * returned alongside an exclusion nothing resolved — so every branch here is tested.
 */

/** What the sink is handed per rejected attempt. Mirrors `output_violation`'s columns. */
export type ViolationSinkRecord = ViolationRecord & {
  constraints: Constraints;
  query: string;
  promptVersion: string;
};

/**
 * Each read and write the pipeline needs, injected as a function.
 *
 * This is not a repository layer (CLAUDE.md §2): `route.ts` still calls the Drizzle
 * queries directly and binds them here, there is no interface over the database, and
 * there is one production binding. They are parameters so the gate wiring can be
 * asserted offline — which also keeps `lib/db/client`, and its required `DATABASE_URL`,
 * out of the unit test's import graph.
 */
export type CookDeps = {
  extract: (query: string) => Promise<ExtractionResult>;
  loadTerms: () => Promise<ResolutionTerm[]>;
  loadTree: () => Promise<IngredientTree>;
  findCandidates: (excludedIds: readonly string[]) => Promise<CandidateRecipe[]>;
  loadIngredients: (recipeIds: readonly string[]) => Promise<Map<string, string[]>>;
  rank: (input: RankingInput, violatedTerms?: readonly string[]) => Promise<RankingResult>;
  recordViolation: (record: ViolationSinkRecord) => Promise<void>;
};

async function constraintsFor(
  input: CookRequest,
  deps: CookDeps,
): Promise<{ ok: true; constraints: Constraints } | { ok: false; response: CookResponse }> {
  if (input.kind === "constraints") return { ok: true, constraints: input.constraints };

  const extracted = await deps.extract(input.query);
  return extracted.ok
    ? { ok: true, constraints: extracted.constraints }
    : { ok: false, response: { kind: "not_understood", reason: extracted.reason } };
}

/** Deterministic order for a list nothing ranked: soonest first, unknown times last. */
function bySoonest(a: CandidateRecipe, b: CandidateRecipe): number {
  if (a.minutes !== b.minutes) {
    if (a.minutes === null) return 1;
    if (b.minutes === null) return -1;
    return a.minutes - b.minutes;
  }
  return a.title.localeCompare(b.title);
}

/** Explicit rather than a rest-spread: what crosses the boundary is listed, not implied. */
const withoutIngredients = (row: RankingCandidate): CandidateRecipe => ({
  id: row.id,
  title: row.title,
  summary: row.summary,
  minutes: row.minutes,
  serves: row.serves,
});

/**
 * The prose to scan: every field of every entry except the id.
 *
 * Ids are not generated text — call 3 has already replaced them with the candidate row's
 * own spelling, and an id it invented is gone before this runs. Scanning them would also
 * fail closed for nothing: `scanProse` matches at a word start and treats `-` as a
 * boundary, so a uuid segment beginning "beef" is a hit for a beef exclusion.
 */
function generatedProse(result: RankingResult): string[] {
  if (!result.ok) return [];
  // A deny-list, not a pick: `id` is blanked and everything else is scanned, so a field
  // added to the ranking schema later is covered by default. Listing the fields to scan
  // instead would silently stop covering the new one.
  return collectStrings(result.ranking.map((entry) => ({ ...entry, id: "" })));
}

export async function runCook(input: CookRequest, deps: CookDeps): Promise<CookResponse> {
  const step = await constraintsFor(input, deps);
  if (!step.ok) return step.response;
  const { constraints } = step;

  // Gate 1's terms and gate 3's tree are two reads of the same tables; neither depends
  // on the other, so the round trips overlap rather than add up.
  const [termRows, tree] = await Promise.all([deps.loadTerms(), deps.loadTree()]);

  const resolutions = resolveExclusions(constraints.exclude, buildResolutionIndex(termRows));
  const unresolved = resolutions.flatMap((r) => (r.kind === "unresolved" ? [r.term] : []));
  if (unresolved.length > 0) {
    // No query and no model call. An exclusion nothing could map is a question for the
    // cook, and any rows returned here would be filtered on less than they asked for.
    return { kind: "needs_resolution", constraints, unresolved };
  }
  const excludedIds = resolutions.flatMap((r) => (r.kind === "resolved" ? [r.canonicalId] : []));

  const rows = await deps.findCandidates(excludedIds);
  const ingredients = await deps.loadIngredients(rows.map((row) => row.id));
  const candidates: RankingCandidate[] = rows.map((row) => ({
    ...row,
    ingredients: ingredients.get(row.id) ?? [],
  }));

  // Time is the one soft constraint that eliminates rather than ranks: a 90-minute
  // braise at position five is not an answer to "twenty-five minutes". An unstated
  // cooking time counts as over the limit, because it is not a promise that it fits.
  const limit = constraints.maxMinutes;
  const within =
    limit === null
      ? candidates
      : candidates.filter((row) => row.minutes !== null && row.minutes <= limit);

  if (within.length === 0) {
    const wouldMatch = candidates.length;
    return {
      kind: "no_candidates",
      constraints,
      relaxTime: limit !== null && wouldMatch > 0 ? { limit, wouldMatch } : null,
    };
  }

  const terms = outputTerms(tree.nodes, tree.aliases, excludedIds);

  // A call 3 failure scans as clean, because there is no prose in it to scan. That is
  // what keeps an API error out of the gate's retry, but it would also let the retry be
  // recorded as a success when it never produced a sentence — so the outcome of the
  // second attempt is tracked here and the record is corrected with it.
  let retryWroteProse = false;
  let attempt = 0;

  const gate = await runOutputGate<RankingResult>({
    generate: async (violatedTerms) => {
      attempt += 1;
      const result = await deps.rank({ candidates: within, constraints }, violatedTerms);
      if (attempt === 2) retryWroteProse = result.ok;
      return result;
    },
    scan: (result) => generatedProse(result).flatMap((text) => scanProse(text, terms)),
    onViolation: (record) =>
      deps.recordViolation({
        ...record,
        retrySucceeded: record.retrySucceeded && retryWroteProse,
        constraints,
        query: input.kind === "query" ? input.query : JSON.stringify(constraints),
        promptVersion: RANKING_VERSION,
      }),
  });

  const cards = (reason: "output_violation" | "ranking_unavailable"): CookResponse => ({
    kind: "cards",
    constraints,
    results: [...within].sort(bySoonest).slice(0, MAX_RESULTS).map(withoutIngredients),
    reason,
  });

  if (gate.kind === "downgraded") return cards("output_violation");
  // Call 3 failing is not a gate event: the rows are still correct, so they still go
  // out, and the retry is not spent on an API error.
  if (!gate.output.ok) return cards("ranking_unavailable");

  const byId = new Map(within.map((row) => [row.id, row]));
  return {
    kind: "ranked",
    constraints,
    attempts: gate.attempts,
    results: gate.output.ranking.flatMap((entry) => {
      const row = byId.get(entry.id);
      return row ? [{ recipe: withoutIngredients(row), rationale: entry.rationale }] : [];
    }),
  };
}
