import type { ExtractionResult } from "@/lib/ai/prompts/extract-constraints";
import {
  MAX_RESULTS,
  type RankingCandidate,
  type RankingInput,
  type RankingResult,
} from "@/lib/ai/prompts/rank-and-explain";
import type { CandidateRecipe } from "@/lib/db/candidates";
import type { IngredientTree } from "@/lib/db/ingredients";
import type { ResolutionTerm } from "@/lib/db/terms";
import type { Constraints } from "@/lib/domain/constraints";
import { buildResolutionIndex, resolveExclusions } from "@/lib/domain/resolve-exclusions";

import type { CookRequest, CookResponse } from "./schema";

/**
 * The Cook pipeline: constraint extraction → gate 1 → gate 2 → call 3 under gate 3.
 *
 * Each gate is already correct on its own. This is the one place a wiring slip defeats a
 * correct gate — the wrong ids into gate 2, the wrong terms into gate 3, or rows
 * returned alongside an exclusion nothing resolved — so every branch here is tested.
 */

/** What gate 3 hands the sink for each rejected attempt. Mirrors `output_violation`. */
export type ViolationSinkRecord = {
  attempt: 1 | 2;
  matchedTerms: string[];
  generated: string;
  retrySucceeded: boolean;
  constraints: Constraints;
  query: string;
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

export async function runCook(input: CookRequest, deps: CookDeps): Promise<CookResponse> {
  const step = await constraintsFor(input, deps);
  if (!step.ok) return step.response;
  const { constraints } = step;

  const index = buildResolutionIndex(await deps.loadTerms());
  const resolutions = resolveExclusions(constraints.exclude, index);
  const excludedIds = resolutions.flatMap((r) => (r.kind === "resolved" ? [r.canonicalId] : []));

  const rows = await deps.findCandidates(excludedIds);
  const ingredients = await deps.loadIngredients(rows.map((row) => row.id));
  const candidates: RankingCandidate[] = rows.map((row) => ({
    ...row,
    ingredients: ingredients.get(row.id) ?? [],
  }));

  const ranked = await deps.rank({ candidates, constraints });
  if (!ranked.ok) {
    return {
      kind: "cards",
      constraints,
      results: candidates.slice(0, MAX_RESULTS),
      reason: "ranking_unavailable",
    };
  }

  const byId = new Map(candidates.map((row) => [row.id, row]));
  return {
    kind: "ranked",
    constraints,
    attempts: 1,
    results: ranked.ranking.flatMap((entry) => {
      const recipe = byId.get(entry.id);
      return recipe ? [{ recipe, rationale: entry.rationale }] : [];
    }),
  };
}
