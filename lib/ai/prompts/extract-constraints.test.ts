// @gate resolution
import { APIConnectionError, APIError, AnthropicError } from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it, vi } from "vitest";

import { MODELS } from "@/lib/ai/client";
import { constraintsSchema } from "@/lib/domain/constraints";
import { ALLERGENS } from "@/lib/domain/taxonomy";

import { extractConstraints, type ConstraintsClient } from "./extract-constraints";

// Call 1 with a stubbed client: no network. Every path either returns constraints that
// parsed under constraintsSchema or returns none — a failure must never read as
// "no exclusions", because gate 1 would then have nothing to ask about.

type Reply = { stop_reason: string | null; parsed_output: unknown } | Error;

function stub(reply: Reply) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const client: ConstraintsClient = {
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

const valid = {
  exclude: ["dairy"],
  avoid: ["curry"],
  have: ["cauliflower"],
  maxMinutes: 25,
};

describe("extractConstraints", () => {
  it("returns constraints parsed by constraintsSchema for valid model output", async () => {
    const { client } = stub({ stop_reason: "end_turn", parsed_output: valid });
    expect(await extractConstraints("half a cauliflower, no dairy", client)).toEqual({
      ok: true,
      constraints: constraintsSchema.parse(valid),
    });
  });

  it("rejects a negative maxMinutes as parse_failed, with no partial constraints", async () => {
    const { client } = stub({ stop_reason: "end_turn", parsed_output: { ...valid, maxMinutes: -5 } });
    expect(await extractConstraints("no dairy", client)).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("rejects an empty-string exclude term as parse_failed", async () => {
    const { client } = stub({ stop_reason: "end_turn", parsed_output: { ...valid, exclude: [""] } });
    expect(await extractConstraints("no dairy", client)).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("treats missing parsed output as parse_failed", async () => {
    const { client } = stub({ stop_reason: "end_turn", parsed_output: null });
    expect(await extractConstraints("no dairy", client)).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("treats a max_tokens stop as parse_failed even when output parses", async () => {
    const { client } = stub({ stop_reason: "max_tokens", parsed_output: valid });
    expect(await extractConstraints("no dairy", client)).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("returns refused on a refusal stop", async () => {
    const { client } = stub({ stop_reason: "refusal", parsed_output: null });
    expect(await extractConstraints("no dairy", client)).toEqual({ ok: false, reason: "refused" });
  });

  it("maps SDK API and connection errors to api_error", async () => {
    for (const error of [
      new APIError(500, undefined, "server error", new Headers()),
      new APIConnectionError({ message: "offline" }),
    ]) {
      const { client } = stub(error);
      expect(await extractConstraints("no dairy", client)).toEqual({ ok: false, reason: "api_error" });
    }
  });

  it("maps the SDK's structured-output parse error to parse_failed", async () => {
    const { client } = stub(new AnthropicError("Failed to parse structured output as JSON: nope"));
    expect(await extractConstraints("no dairy", client)).toEqual({ ok: false, reason: "parse_failed" });
  });

  it("returns empty_query for a blank query without calling the model", async () => {
    for (const query of ["", "   "]) {
      const { client, calls } = stub({ stop_reason: "end_turn", parsed_output: valid });
      expect(await extractConstraints(query, client)).toEqual({ ok: false, reason: "empty_query" });
      expect(calls).toHaveLength(0);
    }
  });

  // The default client must not be built before the blank check: with no key it throws.
  it("returns empty_query without a client or an API key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    try {
      expect(await extractConstraints("  ")).toEqual({ ok: false, reason: "empty_query" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the fast model and names every allergen root in the system prompt", async () => {
    const { client, calls } = stub({ stop_reason: "end_turn", parsed_output: valid });
    await extractConstraints("no dairy", client);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(MODELS.fast);
    const system = calls[0].system;
    expect(typeof system).toBe("string");
    for (const allergen of ALLERGENS) expect(system).toContain(allergen);
  });
});
