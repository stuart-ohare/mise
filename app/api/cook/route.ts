import { extractConstraints } from "@/lib/ai/prompts/extract-constraints";
import { rankAndExplain } from "@/lib/ai/prompts/rank-and-explain";
import { findCandidateRecipes, loadCandidateIngredients } from "@/lib/db/candidates";
import { db } from "@/lib/db/client";
import { loadIngredientTree } from "@/lib/db/ingredients";
import { outputViolation } from "@/lib/db/schema";
import { loadResolutionTerms } from "@/lib/db/terms";

import { runCook, type CookDeps } from "./run";
import { cookRequestSchema, cookResponseSchema } from "./schema";

/**
 * The HTTP shell: parse in, run the pipeline, parse out. The Drizzle queries are called
 * from here, which is the layer CLAUDE.md §2 puts them in; `runCook` receives them so
 * the gate wiring can be tested without a database.
 */

/** Exported so the violation sink's row fan-out can be asserted without a database. */
export const deps: CookDeps = {
  extract: (query) => extractConstraints(query),
  loadTerms: () => loadResolutionTerms(db),
  loadTree: () => loadIngredientTree(db),
  findCandidates: (excludedIds) => findCandidateRecipes(db, excludedIds),
  loadIngredients: (recipeIds) => loadCandidateIngredients(db, recipeIds),
  rank: (input, violatedTerms) => rankAndExplain(input, undefined, violatedTerms),

  /**
   * One row per matched term, because `matched_term` is singular: counting which foods
   * prose reaches for is the reason this table exists. A rejected output is a logged,
   * counted event, never a swallowed one (§6).
   */
  recordViolation: async (record) => {
    await db.insert(outputViolation).values(
      record.matchedTerms.map((matchedTerm) => ({
        query: record.query,
        excluded: record.constraints.exclude,
        matchedTerm,
        generated: record.generated,
        promptVersion: record.promptVersion,
        retrySucceeded: record.retrySucceeded,
      })),
    );
  },
};

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = cookRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    // Parsed on the way out too: a pipeline that returned a shape the screen can't
    // render should fail here, where it is one stack trace, not there, where it is a
    // blank page.
    return Response.json(cookResponseSchema.parse(await runCook(parsed.data, deps)));
  } catch (error) {
    // Gates 2 and 3 both fail loudly by design — `assertKnownIds` on an id that isn't a
    // canonical ingredient, `outputTerms` on an exclusion that contributes no term to
    // scan for. Both mean the catalogue and the request disagree, and both must stay
    // visible rather than becoming an anonymous 500 (§6). No rows go out either way.
    console.error("[cook] request failed before a response could be validated", error);
    return Response.json({ error: "cook_failed" }, { status: 500 });
  }
}
