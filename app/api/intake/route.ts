import { extractRecipe } from "@/lib/ai/prompts/extract-recipe";
import { db } from "@/lib/db/client";
import { writeIntakeDraft } from "@/lib/db/drafts";
import { loadIngredientTree } from "@/lib/db/ingredients";
import { loadResolutionTerms } from "@/lib/db/terms";

import { runIntake, type IntakeDeps } from "./run";
import { intakeRequestSchema, intakeResponseSchema } from "./schema";

/**
 * The HTTP shell: parse in, run the pipeline, parse out. The Drizzle queries are called
 * from here, which is the layer CLAUDE.md §2 puts them in; `runIntake` receives them so
 * gate 1's wiring can be tested without a database.
 */

export const deps: IntakeDeps = {
  extract: (text) => extractRecipe(text),
  loadTerms: () => loadResolutionTerms(db),
  loadTree: () => loadIngredientTree(db),
  // The transaction opens here rather than inside the write, so the boundary is visible
  // at the layer that owns the request: four tables land together or none of them do.
  writeDraft: (input) => db.transaction((tx) => writeIntakeDraft(tx, input)),
};

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = intakeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    return Response.json(intakeResponseSchema.parse(await runIntake(parsed.data, deps)));
  } catch (error) {
    // A draft that can't be parsed on the way out is a draft that was written and can't
    // be rendered. The rows are still in the queue and still correct, so this fails loudly
    // here rather than becoming a blank screen there (§6).
    console.error("[intake] request failed before a response could be validated", error);
    return Response.json({ error: "intake_failed" }, { status: 500 });
  }
}
