import { AnthropicError, APIError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";

import { anthropic, MODELS } from "@/lib/ai/client";
import { constraintsSchema, type Constraints } from "@/lib/domain/constraints";
import { ALLERGENS } from "@/lib/domain/taxonomy";

/**
 * Call 1: a Cook query → typed constraints. Fast model, no catalogue in context.
 *
 * What this call gets wrong decides what gate 1 can see: an exclusion it never extracts
 * is never resolved, never asked about and never filtered. So every rule below pushes
 * errors toward over-exclusion, and every failure returns no constraints at all.
 */

export const VERSION = "1";

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
- When the user means a whole allergen group, however they phrase it ("-free", "products", "intolerant", "allergy"), use exactly one of these names: ${ALLERGENS.join(", ")}. For example "lactose intolerant" is dairy.
- Otherwise use the food itself as a bare lowercase noun, in the user's own words ("allergic to celery" → "celery"). No qualifiers, no "free", no "no".
- An exception never narrows an exclusion. "No nuts, except almonds are OK" → exclude contains "nuts", and almonds appear in no field at all.

avoid: soft preferences that are about fatigue, mood or recent history rather than a food being unsafe or unwanted ("bored of stir-fries" → "stir-fry", "we had fish last night" → "fish"). A bare lowercase noun for the dish or food.

have: ingredients the cook says they have or want to use, as bare lowercase nouns without quantities ("a couple of courgettes" → "courgettes").

maxMinutes: the time limit in whole minutes, only when one is stated ("ready in 45 minutes" → 45, "within the hour" → 60, "a quarter of an hour" → 15). "Quick" or "fast" with no number is null. Never infer a number.

Rules for every field:
- Never put a person's name, or who the meal is for, in any field.
- Words that are not a food ("something light", "nothing fancy") go in no field.
- Each food appears once, in one field. An empty list is a correct answer.`;

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
  client: ConstraintsClient = anthropic(),
): Promise<ExtractionResult> {
  const text = query.trim();
  if (text === "") return { ok: false, reason: "empty_query" };

  let message: Awaited<ReturnType<ConstraintsClient["messages"]["parse"]>>;
  try {
    message = await client.messages.parse({
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
  return parsed.success ? { ok: true, constraints: parsed.data } : { ok: false, reason: "parse_failed" };
}
