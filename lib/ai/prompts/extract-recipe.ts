import { AnthropicError, APIError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";

import { anthropic, MODELS } from "@/lib/ai/client";
import type { ImageMediaType } from "@/lib/domain/image-input";
import { draftRecipeSchema, type DraftRecipe } from "@/lib/domain/intake-draft";

/**
 * Call 2: a pasted wall of recipe text, or a photograph of a recipe card → a structured
 * draft with per-field confidence. Capable model per `client.ts`: long, messy input where
 * a mistake is expensive, and the only one of the three with vision.
 *
 * Nothing this call returns is published. It writes a draft and a score per field, and a
 * human promotes it from /review (CLAUDE.md §2). So the failure worth designing against
 * is not a refusal — it is a plausible invention that a reviewer skims past, which is
 * why every rule below pushes an uncertain reading toward null and a low score.
 *
 * It is never shown the ingredient catalogue and never picks a canonical id. Resolution
 * is gate 1's, in `buildIntakeDraft`, against the index Cook uses.
 */

// 2: the prompt no longer claims its input is always text (#73). The bump is what lets
// a job row say which wording produced it — a v1 report that read a photograph would be
// a lie about a call that never happened (§4.6).
export const VERSION = "2";

// Structured output can't express `.min(1)`, `.positive()` or a bounded score, so the
// model gets a plain shape and every response is then parsed with `draftRecipeSchema`.
export const modelOutputSchema = z.object({
  title: z.string(),
  serves: z.number().int().nullable(),
  minutes: z.number().int().nullable(),
  ingredients: z.array(
    z.object({
      rawText: z.string(),
      name: z.string(),
      qty: z.number().nullable(),
      unit: z.string().nullable(),
      optional: z.boolean(),
      confidence: z.number(),
    }),
  ),
  steps: z.array(z.string()),
  confidence: z.object({
    title: z.number(),
    serves: z.number(),
    minutes: z.number(),
  }),
});

export const SYSTEM = `You are given one recipe: either its text, usually pasted from a blog or a cookbook and surrounded by things that are not the recipe, or a photograph of a recipe card that may be handwritten. Return it as structured data for a human reviewer to check.

Nothing you return is published. A person reads it next and corrects it. That makes a missing value cheap and an invented one expensive: a blank is something they will fill in, and a plausible wrong number is something they will skim past and approve.

So the rule that matters most: if the text does not state something, return null. Never infer a typical amount, a usual tin size, a normal oven time or a standard number of servings. "A knob of butter" states no quantity, so qty is null — not 1, not 25. "Season to taste" states no quantity. A recipe that never says how many it feeds has serves null, however obvious four looks.

Return these fields.

title: what the recipe is called. If the text gives no title, use the shortest plain description of the dish rather than inventing a name for it.

serves: how many people it feeds, as a whole number, only when the text says so. Otherwise null.

minutes: total time in whole minutes, only when the text says so. Add stated times together when the text splits them ("15 minutes prep, 40 minutes in the oven" is 55). "Quick", "weeknight" and "ready in no time" state no time: null.

ingredients: one entry per ingredient line, in the order the recipe lists them.
- rawText: the line exactly as written, copied character for character. Do not tidy it, expand an abbreviation, fix a typo or drop a note like "or more to taste". This is what the reviewer compares against, so it must be what the source said.
- name: just the food from that line, lowercase, with no quantity, no unit and no preparation. "2 tbsp ghee, melted" is "ghee". "150g plain flour, sifted" is "plain flour". "1 x 400g tin chopped tomatoes" is "chopped tomatoes". Keep the words the recipe used — do not translate a regional name into one you think is more standard, and do not generalise a specific ingredient into its category.
- qty: the number, only when stated. Convert a fraction or a range's lower bound to a number ("½" is 0.5, "2-3" is 2). Null when the line states no number.
- unit: the unit as written ("g", "tbsp", "tin", "clove"), or null when the line has none.
- optional: true only when the line itself says the ingredient is optional or "to serve" or "if you like".

steps: the method, one entry per step, in order, as written. Leave out anything that is not an instruction — a story about the author's grandmother, a note about the photography, an advert.

confidence: how sure you are that you read the text correctly, from 0 to 1, for title, serves and minutes, and once more on every ingredient line. Score the reading, not the value: a null you are certain about, because the text plainly never says it, is a high score. A number you had to pick between two readings is a low one. Do not give everything the same score — a flat set of scores tells the reviewer nothing about where to look.

If what you are given is not a recipe at all, or has no ingredient list in it, return empty ingredients and steps arrays. Do not assemble a recipe out of what is there.`;

/**
 * Where the recipe came from. The union is the only thing that differs between the two
 * paths — same model, same system prompt, same schema, same failure reasons — because
 * vision changes where the words are, not what they mean.
 */
export type RecipeSource =
  | { kind: "text"; text: string }
  | { kind: "image"; mediaType: ImageMediaType; data: string };

export type RecipeExtractionResult =
  | { ok: true; draft: DraftRecipe }
  | { ok: false; reason: "empty_input" | "refused" | "parse_failed" | "api_error" };

/**
 * The user turn: a paste is one text block, a card is one image block. A card gets no
 * accompanying text — every instruction is in SYSTEM, and a second copy in the user turn
 * would be one more thing to keep in step with `VERSION`.
 */
function content(source: RecipeSource): ContentBlockParam[] {
  return source.kind === "text"
    ? [{ type: "text", text: source.text }]
    : [
        {
          type: "image",
          source: { type: "base64", media_type: source.mediaType, data: source.data },
        },
      ];
}

/** Nothing to read: no key needed, no call made, and no job row worth writing. */
function isEmpty(source: RecipeSource): boolean {
  return source.kind === "text" ? source.text === "" : source.data === "";
}

/**
 * The slice of the Anthropic client this call uses. `parsed_output` is `unknown` on
 * purpose: it is parsed with `draftRecipeSchema` here whatever the SDK already checked.
 */
export interface RecipeClient {
  messages: {
    parse(
      params: MessageCreateParamsNonStreaming,
    ): PromiseLike<{ stop_reason: string | null; parsed_output: unknown }>;
  };
}

export async function extractRecipe(
  input: RecipeSource,
  client?: RecipeClient,
): Promise<RecipeExtractionResult> {
  const source: RecipeSource =
    input.kind === "text" ? { kind: "text", text: input.text.trim() } : input;
  if (isEmpty(source)) return { ok: false, reason: "empty_input" };
  // Built only after the blank check, so an empty paste never needs an API key.
  const { messages } = client ?? anthropic();

  let message: Awaited<ReturnType<RecipeClient["messages"]["parse"]>>;
  try {
    message = await messages.parse({
      model: MODELS.capable,
      // A long recipe with a line-by-line confidence is the widest output in the app.
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: "user", content: content(source) }],
      output_config: { format: zodOutputFormat(modelOutputSchema) },
    });
  } catch (error) {
    if (error instanceof APIError) return { ok: false, reason: "api_error" };
    // The SDK throws a plain AnthropicError when output isn't JSON or fails the model schema.
    if (error instanceof AnthropicError) return { ok: false, reason: "parse_failed" };
    throw error;
  }

  if (message.stop_reason === "refusal") return { ok: false, reason: "refused" };
  // A truncated response can still parse, but it may have lost an ingredient — which is
  // exactly where an allergen hides. A half-read recipe is not a draft worth reviewing.
  if (message.stop_reason !== "end_turn") return { ok: false, reason: "parse_failed" };

  // `draftRecipeSchema` requires at least one ingredient and one step, so the empty
  // arrays the prompt asks for on a non-recipe arrive here as `parse_failed`. That is the
  // intended answer: a recipe with nothing in it is not a draft anyone can promote, and no
  // extraction_job row is worth writing for it.
  const parsed = draftRecipeSchema.safeParse(message.parsed_output);
  return parsed.success
    ? { ok: true, draft: parsed.data }
    : { ok: false, reason: "parse_failed" };
}
