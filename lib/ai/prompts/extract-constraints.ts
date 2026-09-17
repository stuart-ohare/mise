import { AnthropicError, APIError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";

import { anthropic, MODELS } from "@/lib/ai/client";
import { normaliseTerm } from "@/lib/domain/resolve-exclusions";
import { constraintsSchema, type Constraints } from "@/lib/domain/constraints";
import { ALLERGENS } from "@/lib/domain/taxonomy";

/**
 * Call 1: a Cook query → typed constraints. Fast model, no catalogue in context.
 *
 * What this call gets wrong decides what gate 1 can see: an exclusion it never extracts
 * is never resolved, never asked about and never filtered. So every rule below pushes
 * errors toward over-exclusion, and every failure returns no constraints at all.
 */

export const VERSION = "5";

// Structured output can't express `.min(1)` or `.positive()`, so the model gets a plain
// shape and every response is then parsed with `constraintsSchema`.
export const modelOutputSchema = z.object({
  exclude: z.array(z.string()),
  avoid: z.array(z.string()),
  have: z.array(z.string()),
  maxMinutes: z.number().int().nullable(),
});

// Examples here deliberately don't reuse the eval fixtures' wording, so a passing run
// shows the rules generalise rather than that the model recognised its own examples.
export const SYSTEM = `You read one request from a home cook and extract what they asked for as structured constraints. Someone in the household may have a food allergy, so a hard exclusion that you miss can make them ill, while an exclusion you add unnecessarily only removes a few recipes.

Return four fields.

exclude: foods that must not be in the dish. Hard constraints.
- Include every statement that a named food should not be eaten, however firmly or casually it is phrased: an allergy, an intolerance, "can't have", "cutting back on", "not keen on", "hates". For example "allergic to celery", "I'm off sugar at the moment", "not keen on olives". If in doubt whether something is a hard exclusion or a preference, put it in exclude.
- An exclusion that applies to someone else ("my daughter can't eat mustard") is still an exclusion.
- The allergen group names are exactly: ${ALLERGENS.join(", ")}. Whenever the request refers to one of these groups, in any wording ("no soy", "gluten-free", "egg allergy", "can't have nuts", "lactose intolerant" for dairy), exclude contains that group name.
- When the user names one food, exclude that food by its own name, as a bare lowercase noun in their words, even if it belongs to a group: "allergic to walnuts" → "walnuts", not "nuts"; "no mussels" → "mussels", not "shellfish"; "allergic to celery" → "celery". No qualifiers, no "free", no "no".
- An exception never narrows an exclusion, and never removes it. When a request excludes something and then allows part of it ("no nuts, except almonds are OK", "nothing with egg, though mayo is fine"), the exclusion still goes in exclude exactly as if the exception had not been said, and the allowed food goes in no field at all: not in have, not in avoid. An allowed food is not an ingredient the cook has.

avoid: soft preferences that are about fatigue, mood or recent history rather than a food being unsafe or unwanted ("bored of stir-fries" → "stir-fry", "we had fish last night" → "fish", "sick of risotto" → "risotto", "not in the mood for soup" → "soup"). Being tired of a dish is avoid, never exclude, however it is phrased. A bare lowercase noun for the dish or food.

have: ingredients the cook says they have or want to use, as bare lowercase nouns without quantities ("a couple of courgettes" → "courgettes").

maxMinutes: the time limit in whole minutes, only when one is stated ("ready in 45 minutes" → 45, "within the hour" → 60, "a quarter of an hour" → 15). "Quick" or "fast" with no number is null. Never infer a number.

Rules for every field:
- Never put a person's name, or who the meal is for, in any field.
- Only foods and dishes go in any field. Descriptions of a meal ("something light", "nothing too rich", "nothing fancy") go in no field; do not turn their adjectives into terms.
- Each food appears once, in one field. If a food is excluded anywhere in the request, it goes in exclude only, whatever else is said about it: "sick of lentils, and lentils upset my stomach" → exclude "lentils", not avoid; "a jar of honey to finish, but the baby can't have honey" → exclude "honey", not have. An excluded food never appears in avoid or have.
- An empty list is a correct answer.

Before answering, check exclude against the request: a request can mix several constraints in one sentence (what the cook has, a time limit, what they are tired of), and every phrase saying a food must not be eaten ("no …", "… -free", "can't have", "allergic to", "without …") must still produce its own exclude term. A phrase about being tired of or bored with a dish is avoid, not exclude. If the request says any food or group must not be eaten, exclude is not empty.`;

export type ExtractionResult =
  | { ok: true; constraints: Constraints }
  | { ok: false; reason: "empty_query" | "refused" | "parse_failed" | "api_error" };

/**
 * The slice of the Anthropic client this call uses. `parsed_output` is `unknown` on
 * purpose: it is parsed with `constraintsSchema` here whatever the SDK already checked.
 */
export interface ConstraintsClient {
  messages: {
    parse(params: MessageCreateParamsNonStreaming): PromiseLike<{ stop_reason: string | null; parsed_output: unknown }>;
  };
}

export async function extractConstraints(
  query: string,
  client?: ConstraintsClient,
): Promise<ExtractionResult> {
  const text = query.trim();
  if (text === "") return { ok: false, reason: "empty_query" };
  // Built only after the blank check, so an empty query never needs an API key.
  const { messages } = client ?? anthropic();

  let message: Awaited<ReturnType<ConstraintsClient["messages"]["parse"]>>;
  try {
    message = await messages.parse({
      model: MODELS.fast,
      max_tokens: 512,
      system: SYSTEM,
      messages: [{ role: "user", content: text }],
      output_config: { format: zodOutputFormat(modelOutputSchema) },
    });
  } catch (error) {
    if (error instanceof APIError) return { ok: false, reason: "api_error" };
    // The SDK throws a plain AnthropicError when output isn't JSON or fails the model schema.
    if (error instanceof AnthropicError) return { ok: false, reason: "parse_failed" };
    throw error;
  }

  if (message.stop_reason === "refusal") return { ok: false, reason: "refused" };
  // A truncated response can still parse, but it may have lost an exclusion.
  if (message.stop_reason !== "end_turn") return { ok: false, reason: "parse_failed" };

  const parsed = constraintsSchema.safeParse(message.parsed_output);
  return parsed.success
    ? { ok: true, constraints: excludeWins(parsed.data) }
    : { ok: false, reason: "parse_failed" };
}

/**
 * The prompt asks for an excluded food to appear only in `exclude`; this makes it true
 * whatever the model returns. Only the soft fields are touched, never `exclude`: a food
 * that is both excluded and merely disliked is excluded, and a ranking weight must not
 * restate a hard constraint.
 */
function excludeWins(constraints: Constraints): Constraints {
  const excluded = new Set(constraints.exclude.map(normaliseTerm));
  const keep = (terms: string[]) => terms.filter((term) => !excluded.has(normaliseTerm(term)));
  return { ...constraints, avoid: keep(constraints.avoid), have: keep(constraints.have) };
}
