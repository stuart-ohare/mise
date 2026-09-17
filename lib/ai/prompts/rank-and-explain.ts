import { AnthropicError, APIError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";

import { anthropic, MODELS } from "@/lib/ai/client";
import { candidateRecipeSchema } from "@/lib/db/candidates";
import type { Constraints } from "@/lib/domain/constraints";

/**
 * Call 3: pre-filtered rows plus the constraints → an ordered shortlist with a
 * one-line rationale each. Capable model: the input is long and a rationale that
 * misreads a row is expensive.
 *
 * Gate 2 decided what exists. This call only orders and explains it, so an id that
 * wasn't in the input rows is dropped here rather than trusted — see `keepKnownIds`.
 */

export const VERSION = "1";

/** A shortlist, not a ranking of everything. The cook is choosing dinner, not browsing. */
export const MAX_RESULTS = 5;

const nonBlank = z.string().refine((value) => value.trim().length > 0, "must not be blank");

/**
 * The gate 2 row plus what's in it. The names are what make `have` rankable; fetching
 * them belongs to the caller, so gate 2's query is untouched by this call.
 */
export const rankingCandidateSchema = candidateRecipeSchema.extend({
  ingredients: z.array(nonBlank),
});

export type RankingCandidate = z.infer<typeof rankingCandidateSchema>;

// Structured output can't express the blankness refinement, so the model gets a plain
// shape and every response is then parsed with `rankingSchema`.
export const modelOutputSchema = z.object({
  ranking: z.array(z.object({ id: z.string(), rationale: z.string() })),
});

export const rankingSchema = z.object({
  ranking: z.array(z.object({ id: nonBlank, rationale: nonBlank })),
});

export type RankedRecipe = z.infer<typeof rankingSchema>["ranking"][number];

/**
 * `no_valid_ids` is a failure rather than an empty shortlist: a model that invented
 * every id must not read as "nothing here suits you".
 *
 * `dropped` carries the ids gate 2 never handed the model, so a fabrication is a
 * counted event and not a silently shorter list (CLAUDE.md §6). It appears only where
 * a response existed to fabricate in: `dropped: []` on an `api_error` would read as
 * "the model invented nothing" rather than "the model never answered".
 *
 * Gate 3 must scan `ranking` and not this whole result. `dropped` holds model-authored
 * strings that by definition never render, and an invented id shaped like a slug —
 * "butter-bean-stew" — would match an excluded term, rejecting clean prose and writing
 * a violation whose `matched_term` appeared in no rationale. `collectStrings` reaches
 * every field it is given, so the caller chooses what it is given.
 */
export type RankingResult =
  | { ok: true; ranking: RankedRecipe[]; dropped: string[] }
  | { ok: false; reason: "no_valid_ids"; dropped: string[] }
  | {
      ok: false;
      reason: "no_candidates" | "refused" | "parse_failed" | "api_error";
    };

/**
 * Static: the rules only. The candidates and constraints travel in the user message, so
 * `VERSION` changes when the rules change and not once per request (CLAUDE.md §4.6).
 */
export const SYSTEM = `You are given recipes a cook could make right now, and what they asked for. Put them in order and say why, one line each.

Every recipe you are given has already been checked against the cook's hard exclusions by a database query. You are not deciding what is safe to eat. You are ordering what is already safe, and explaining it.

Return one field, ranking: at most ${MAX_RESULTS} entries, best first, each with an id and a rationale.

id: copied exactly from one of the candidate rows you were given. Never invent an id, never alter one, never repeat one. Only the recipes you were given exist; there is nothing else to rank. Returning fewer than ${MAX_RESULTS} is a correct answer when fewer suit.

rationale: one short sentence about that recipe and no other — what it uses, how long it takes, why it fits this request. A sentence that would fit any recipe is not a rationale. Do not promise a substitution, a saving or a shortcut the row doesn't show you.

Order by, most important first:
1. uses what the cook says they have
2. fits the time limit, when one is given
3. is not something the cook says they are tired of
4. otherwise, the better dinner tonight

The request carries a field named exclude: the foods this household must not eat. Never write the name of anything listed there, or of anything made from one, anywhere in a rationale. Not to reassure the cook, not to point out that a dish is free of it, not as "no X", "X-free", "without X" or "instead of X", and not in passing. The rows are already safe, so there is nothing to reassure anyone about, and naming the food is exactly what must not happen. If a rationale needs one of those words, the rationale is wrong: write a different one about what the dish actually is.

The request may also carry a field named forbidden: words an earlier attempt used that broke that rule. No rationale may contain any of them, in any form.`;

/**
 * The slice of the Anthropic client this call uses. `parsed_output` is `unknown` on
 * purpose: it is parsed with `rankingSchema` here whatever the SDK already checked.
 */
export interface RankingClient {
  messages: {
    parse(
      params: MessageCreateParamsNonStreaming,
    ): PromiseLike<{ stop_reason: string | null; parsed_output: unknown }>;
  };
}

export interface RankingInput {
  candidates: readonly RankingCandidate[];
  constraints: Constraints;
}

/**
 * `violatedTerms` is gate 3's retry: the terms the rejected attempt used, named so the
 * next one can avoid them. This call never retries itself — that is the gate's job, and
 * this function is the `generate` it drives.
 */
export async function rankAndExplain(
  input: RankingInput,
  client?: RankingClient,
  violatedTerms?: readonly string[],
): Promise<RankingResult> {
  if (input.candidates.length === 0) return { ok: false, reason: "no_candidates" };
  // Built only after the empty check, so an empty candidate set never needs an API key.
  const { messages } = client ?? anthropic();

  const payload = {
    constraints: input.constraints,
    candidates: input.candidates,
    ...(violatedTerms && violatedTerms.length > 0 ? { forbidden: violatedTerms } : {}),
  };

  let message: Awaited<ReturnType<RankingClient["messages"]["parse"]>>;
  try {
    message = await messages.parse({
      model: MODELS.capable,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(payload, null, 2) }],
      output_config: { format: zodOutputFormat(modelOutputSchema) },
    });
  } catch (error) {
    if (error instanceof APIError) return { ok: false, reason: "api_error" };
    // The SDK throws a plain AnthropicError when output isn't JSON or fails the model schema.
    if (error instanceof AnthropicError) return { ok: false, reason: "parse_failed" };
    throw error;
  }

  if (message.stop_reason === "refusal") return { ok: false, reason: "refused" };
  // A truncated response can still parse, but it may have lost the top result.
  if (message.stop_reason !== "end_turn") return { ok: false, reason: "parse_failed" };

  const parsed = rankingSchema.safeParse(message.parsed_output);
  if (!parsed.success) return { ok: false, reason: "parse_failed" };

  const { kept, dropped } = keepKnownIds(parsed.data.ranking, input.candidates);
  if (kept.length === 0) return { ok: false, reason: "no_valid_ids", dropped };
  return { ok: true, ranking: kept, dropped };
}

/**
 * The drop, in code rather than in the prompt, because the prompt is a request and this
 * is the guarantee: gate 2 decided what exists, so a recipe it never returned cannot
 * reach render however convincingly the model names it.
 *
 * Ids are matched case-insensitively and re-emitted in the candidate's own spelling, so
 * a mangled id can't reach render either. Truncation happens after the drop, so invented
 * ids never push a real recipe out of the shortlist.
 *
 * `dropped` names only the invented ids, each once, in the spelling the model first used.
 * A duplicate and a real id past `MAX_RESULTS` are dropped too, and neither is a
 * fabrication — counting them would inflate the number that is the evidence, and so
 * would counting one hallucination five times because the model repeated it. The whole
 * response is examined for the same reason: the count must not depend on where in the
 * list the invention sat.
 */
function keepKnownIds(
  ranking: readonly RankedRecipe[],
  candidates: readonly RankingCandidate[],
): { kept: RankedRecipe[]; dropped: string[] } {
  const known = new Map(candidates.map((row) => [row.id.toLowerCase(), row.id]));
  const seen = new Set<string>();
  const kept: RankedRecipe[] = [];
  const dropped: string[] = [];

  for (const entry of ranking) {
    const key = entry.id.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const id = known.get(key);
    if (id === undefined) {
      dropped.push(entry.id);
      continue;
    }
    if (kept.length < MAX_RESULTS) kept.push({ id, rationale: entry.rationale });
  }
  return { kept, dropped };
}
