import { APIConnectionError, APIError, AnthropicError } from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";

import { MODELS } from "@/lib/ai/client";

import { extractRecipe, type RecipeClient, type RecipeSource } from "./extract-recipe";

/**
 * Call 2 with a stubbed client: no network. Every path either returns a draft that
 * parsed under `draftRecipeSchema` or returns none — a partial draft must never reach
 * the queue, because the line it lost is the one nobody reviews.
 */

type Reply = { stop_reason: string | null; parsed_output: unknown } | Error;

function stub(reply: Reply) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const client: RecipeClient = {
    messages: {
      async parse(params) {
        calls.push(params);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
  return { client, calls };
}

const text = (value: string): RecipeSource => ({ kind: "text", text: value });

// Every quantity here is stated in its own rawText. Nothing in this file expects a
// number the source doesn't say — a fixture that invented one would be teaching the
// opposite of the rule the prompt exists to enforce.
const valid = {
  title: "Butter beans with chard",
  serves: 2,
  minutes: 25,
  ingredients: [
    {
      rawText: "1 x 400g tin butter beans, drained",
      name: "butter beans",
      qty: 1,
      unit: "tin",
      optional: false,
      confidence: 0.92,
    },
    {
      rawText: "a knob of butter",
      name: "butter",
      qty: null,
      unit: null,
      optional: false,
      confidence: 0.55,
    },
  ],
  steps: ["Warm the beans through.", "Wilt the chard in the butter."],
  confidence: { title: 0.9, serves: 0.8, minutes: 0.45 },
};

const PASTE = "Butter beans with chard\n\n1 x 400g tin butter beans, drained\na knob of butter";

describe("extractRecipe", () => {
  it("returns a draft parsed by draftRecipeSchema for valid model output", async () => {
    const { client } = stub({ stop_reason: "end_turn", parsed_output: valid });
    expect(await extractRecipe(text(PASTE), client)).toEqual({ ok: true, draft: valid });
  });

  it("keeps an unstated quantity null instead of filling one in", async () => {
    const { client } = stub({ stop_reason: "end_turn", parsed_output: valid });
    const result = await extractRecipe(text(PASTE), client);

    // "a knob of butter" states no number, so the draft carries none. A reviewer skims
    // past a plausible 1; they stop at a blank.
    expect(result.ok && result.draft.ingredients[1]).toMatchObject({
      rawText: "a knob of butter",
      qty: null,
      unit: null,
    });
  });

  it("rejects a non-positive quantity as parse_failed, with no partial draft", async () => {
    const ingredients = [{ ...valid.ingredients[0], qty: 0 }];
    const { client } = stub({ stop_reason: "end_turn", parsed_output: { ...valid, ingredients } });
    expect(await extractRecipe(text(PASTE), client)).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("rejects a blank rawText rather than storing a line with no audit trail", async () => {
    const ingredients = [{ ...valid.ingredients[0], rawText: "   " }];
    const { client } = stub({ stop_reason: "end_turn", parsed_output: { ...valid, ingredients } });
    expect(await extractRecipe(text(PASTE), client)).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("rejects a confidence outside 0 to 1 as parse_failed", async () => {
    const confidence = { title: 1.2, serves: 0.8, minutes: 0.45 };
    const { client } = stub({ stop_reason: "end_turn", parsed_output: { ...valid, confidence } });
    expect(await extractRecipe(text(PASTE), client)).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("returns parse_failed for the empty arrays a non-recipe gets, writing no draft", async () => {
    const empty = { ...valid, ingredients: [], steps: [] };
    const { client } = stub({ stop_reason: "end_turn", parsed_output: empty });
    expect(await extractRecipe(text("Terms and conditions apply."), client)).toEqual({
      ok: false,
      reason: "parse_failed",
    });
  });

  it("treats missing parsed output as parse_failed", async () => {
    const { client } = stub({ stop_reason: "end_turn", parsed_output: null });
    expect(await extractRecipe(text(PASTE), client)).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("treats a max_tokens stop as parse_failed even when output parses", async () => {
    const { client } = stub({ stop_reason: "max_tokens", parsed_output: valid });
    expect(await extractRecipe(text(PASTE), client)).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("returns refused on a refusal stop", async () => {
    const { client } = stub({ stop_reason: "refusal", parsed_output: null });
    expect(await extractRecipe(text(PASTE), client)).toEqual({ ok: false, reason: "refused" });
  });

  it("maps SDK API and connection errors to api_error", async () => {
    const api = new APIError(500, undefined, "server error", undefined);
    expect(await extractRecipe(text(PASTE), stub(api).client)).toEqual({
      ok: false,
      reason: "api_error",
    });

    const connection = new APIConnectionError({ message: "socket hang up" });
    expect(await extractRecipe(text(PASTE), stub(connection).client)).toEqual({
      ok: false,
      reason: "api_error",
    });
  });

  it("maps the SDK's structured-output parse error to parse_failed", async () => {
    const { client } = stub(new AnthropicError("could not parse response"));
    expect(await extractRecipe(text(PASTE), client)).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("returns empty_input for a blank paste without calling the model", async () => {
    const { client, calls } = stub({ stop_reason: "end_turn", parsed_output: valid });
    expect(await extractRecipe(text("   \n  "), client)).toEqual({ ok: false, reason: "empty_input" });
    expect(calls).toEqual([]);
  });

  it("returns empty_input without a client or an API key", async () => {
    // No client at all: the blank check has to come before the SDK is built, or an empty
    // textarea is an exception instead of an outcome.
    expect(await extractRecipe(text(""))).toEqual({ ok: false, reason: "empty_input" });
  });

  it("uses the capable model and states the null rule in the system prompt", async () => {
    const { client, calls } = stub({ stop_reason: "end_turn", parsed_output: valid });
    await extractRecipe(text(PASTE), client);

    expect(calls[0]?.model).toBe(MODELS.capable);
    expect(String(calls[0]?.system)).toContain("return null");
    expect(calls[0]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: PASTE }] },
    ]);
  });
});

/**
 * The image branch of the same call. Everything it shares with the text branch is
 * already covered above; what is left is that a card becomes an image block and not a
 * stringified data URI the model would read as gibberish.
 */
describe("extractRecipe, from a photograph", () => {
  const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const card: RecipeSource = { kind: "image", mediaType: "image/png", data: PNG_DATA };

  it("sends the card as a base64 image block on the capable model", async () => {
    const { client, calls } = stub({ stop_reason: "end_turn", parsed_output: valid });
    const result = await extractRecipe(card, client);

    expect(result).toEqual({ ok: true, draft: valid });
    expect(calls[0]?.model).toBe(MODELS.capable);
    expect(calls[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_DATA } },
        ],
      },
    ]);
  });

  it("shows the card the same system prompt, with its null rule intact", async () => {
    const { client, calls } = stub({ stop_reason: "end_turn", parsed_output: valid });
    await extractRecipe(card, client);

    // One prompt for both paths: a card that stated no quantity must produce the same
    // null a paste would, or the image path is a second set of rules nobody evaluated.
    expect(String(calls[0]?.system)).toContain("return null");
    expect(String(calls[0]?.system)).toContain("photograph of a recipe card");
  });

  it("returns empty_input for an image with no data, without calling the model", async () => {
    const { client, calls } = stub({ stop_reason: "end_turn", parsed_output: valid });
    const result = await extractRecipe({ kind: "image", mediaType: "image/png", data: "" }, client);

    expect(result).toEqual({ ok: false, reason: "empty_input" });
    expect(calls).toEqual([]);
  });
});
