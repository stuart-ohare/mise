import { MODELS } from "@/lib/ai/client";
import {
  VERSION as EXTRACTION_VERSION,
  type RecipeExtractionResult,
  type RecipeSource,
} from "@/lib/ai/prompts/extract-recipe";
import type { IntakeWrite, IntakeWritten } from "@/lib/db/drafts";
import type { IngredientTree } from "@/lib/db/ingredients";
import type { ResolutionTerm } from "@/lib/db/terms";
import { parseImageDataUri } from "@/lib/domain/image-input";
import { buildIntakeDraft } from "@/lib/domain/intake-draft";
import { buildResolutionIndex } from "@/lib/domain/resolve-exclusions";

import type { IntakeRequest, IntakeResponse } from "./schema";

/**
 * The Intake pipeline: call 2 → gate 1 → one transaction.
 *
 * Call 2 is never shown the catalogue and never picks a canonical id. Every line it
 * returns is resolved here, against the index Cook resolves exclusions against, and a
 * line that maps to nothing is written as null. That null is the point: it blocks the
 * recipe from leaving draft, and an unknown ingredient is exactly where an allergen
 * hides (CLAUDE.md §2).
 */

/**
 * Each read and write the pipeline needs, injected as a function — the shape `runCook`
 * uses, and for the same reason. This is not a repository layer: `route.ts` still calls
 * the Drizzle queries directly and binds them here, and there is one production binding.
 * They are parameters so gate 1's wiring can be asserted offline, which also keeps
 * `lib/db/client` and its required `DATABASE_URL` out of the unit test's import graph.
 */
export type IntakeDeps = {
  extract: (source: RecipeSource) => Promise<RecipeExtractionResult>;
  loadTerms: () => Promise<ResolutionTerm[]>;
  loadTree: () => Promise<IngredientTree>;
  writeDraft: (input: IntakeWrite) => Promise<IntakeWritten>;
};

export async function runIntake(input: IntakeRequest, deps: IntakeDeps): Promise<IntakeResponse> {
  const source = toSource(input);
  // Only reachable if a caller skipped `intakeRequestSchema`, which the route cannot:
  // a data URI that doesn't split is not an image, and guessing at one would be the
  // opposite of what this pipeline is for.
  if (source === null) return { kind: "not_extracted", reason: "parse_failed" };

  const extracted = await deps.extract(source);
  // Nothing is written on a failure. A row in the queue that holds no recipe is work for
  // a reviewer with nothing at the end of it.
  if (!extracted.ok) return { kind: "not_extracted", reason: extracted.reason };

  // Gate 1's terms and the names the screen shows are two reads of the same two tables;
  // neither depends on the other, so the round trips overlap rather than add up.
  const [termRows, tree] = await Promise.all([deps.loadTerms(), deps.loadTree()]);
  const names = new Map(tree.nodes.map((node) => [node.id, node.name]));

  const draft = buildIntakeDraft(extracted.draft, buildResolutionIndex(termRows), names);

  const { jobId, recipeId } = await deps.writeDraft({
    // Whichever arm matched, `raw` is what arrived — the paste verbatim, or the
    // photograph itself. A job whose raw_input only held a filename would leave the
    // reviewer with no way to check what the model read (§2).
    sourceKind: input.sourceKind,
    rawInput: input.raw,
    model: MODELS.capable,
    promptVersion: EXTRACTION_VERSION,
    output: extracted.draft,
    draft,
  });

  return { kind: "draft", jobId, recipeId, draft };
}

/**
 * The request's `raw` as call 2 wants it. Text goes through as text; an image is split
 * into the media type and the base64 the content block needs.
 */
function toSource(input: IntakeRequest): RecipeSource | null {
  if (input.sourceKind === "text") return { kind: "text", text: input.raw };

  const image = parseImageDataUri(input.raw);
  return image === null ? null : { kind: "image", ...image };
}
