// @gate output
import { APIConnectionError, APIError, AnthropicError } from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it } from "vitest";

import { MODELS } from "@/lib/ai/client";

import {
  MAX_RESULTS,
  rankAndExplain,
  type RankingCandidate,
  type RankingClient,
} from "./rank-and-explain";

// Call 3 with a stubbed client: no network. Gate 2 guarantees the rows, and nothing
// guarantees the ids in the response except checking them against those rows here. A
// recipe the SQL never handed the model must not reach render, whatever the model
// writes — and a response of nothing but invented ids is a failure, not a shortlist
// that happens to be empty.

type Reply = { stop_reason: string | null; parsed_output: unknown } | Error;

function stub(reply: Reply) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const client: RankingClient = {
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

function candidate(id: string, title: string): RankingCandidate {
  return { id, title, summary: null, minutes: 30, serves: 2, ingredients: ["tomatoes"] };
}

const CAULIFLOWER = "11111111-aaaa-4111-8111-1111111111ab";
const STEW = "22222222-bbbb-4222-8222-2222222222cd";
const TRAYBAKE = "33333333-cccc-4333-8333-3333333333ef";
const INVENTED = "99999999-ffff-4999-8999-9999999999ff";

const candidates = [
  candidate(CAULIFLOWER, "Roast cauliflower with capers"),
  candidate(STEW, "Butter bean stew"),
  candidate(TRAYBAKE, "Sausage traybake"),
];

const constraints = {
  exclude: ["dairy"],
  avoid: ["curry"],
  have: ["cauliflower"],
  maxMinutes: 25,
};

const ranked = (...ids: string[]) => ({
  ranking: ids.map((id) => ({ id, rationale: `Uses the cauliflower you have (${id.slice(0, 4)}).` })),
});

/** The single string the model is shown: system rules plus the request payload. */
function prompt(calls: readonly MessageCreateParamsNonStreaming[]): string {
  const call = calls.at(0);
  if (!call) throw new Error("the model was never called");
  return JSON.stringify({ system: call.system, messages: call.messages });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

describe("rankAndExplain", () => {
  it("returns the model's order with each rationale attached", async () => {
    const { client, calls } = stub({
      stop_reason: "end_turn",
      parsed_output: ranked(STEW, CAULIFLOWER),
    });

    const result = await rankAndExplain({ candidates, constraints }, client);

    expect(result).toEqual({
      ok: true,
      ranking: [
        { id: STEW, rationale: expect.any(String) },
        { id: CAULIFLOWER, rationale: expect.any(String) },
      ],
      dropped: [],
    });
    expect(calls[0]?.model).toBe(MODELS.capable);
  });

  it("drops an id that wasn't in the input rows, keeping the rest in order", async () => {
    const { client } = stub({
      stop_reason: "end_turn",
      parsed_output: ranked(CAULIFLOWER, INVENTED, TRAYBAKE),
    });

    const result = await rankAndExplain({ candidates, constraints }, client);

    expect(result.ok).toBe(true);
    expect(result.ok && result.ranking.map((entry) => entry.id)).toEqual([CAULIFLOWER, TRAYBAKE]);
  });

  it("fails when every id was invented, naming each one rather than shortlisting none", async () => {
    const { client } = stub({
      stop_reason: "end_turn",
      parsed_output: ranked(INVENTED, "not-a-uuid"),
    });

    expect(await rankAndExplain({ candidates, constraints }, client)).toEqual({
      ok: false,
      reason: "no_valid_ids",
      dropped: [INVENTED, "not-a-uuid"],
    });
  });

  it("records nothing when every id came from the rows", async () => {
    const { client } = stub({ stop_reason: "end_turn", parsed_output: ranked(STEW, CAULIFLOWER) });

    const result = await rankAndExplain({ candidates, constraints }, client);

    expect(result.ok && result.dropped).toEqual([]);
  });

  it("names each id the model invented alongside the ranking it kept", async () => {
    const { client } = stub({
      stop_reason: "end_turn",
      parsed_output: ranked(CAULIFLOWER, INVENTED, TRAYBAKE),
    });

    expect(await rankAndExplain({ candidates, constraints }, client)).toEqual({
      ok: true,
      ranking: [
        { id: CAULIFLOWER, rationale: expect.any(String) },
        { id: TRAYBAKE, rationale: expect.any(String) },
      ],
      dropped: [INVENTED],
    });
  });

  it("records an invented id as the model wrote it", async () => {
    const written = `  ${INVENTED.toUpperCase()}`;
    const { client } = stub({ stop_reason: "end_turn", parsed_output: ranked(STEW, written) });

    const result = await rankAndExplain({ candidates, constraints }, client);

    expect(result.ok && result.dropped).toEqual([written]);
  });

  it("counts one invention once, however many times the model repeats it", async () => {
    const { client } = stub({
      stop_reason: "end_turn",
      parsed_output: ranked(INVENTED, STEW, `  ${INVENTED.toUpperCase()}`, INVENTED),
    });

    const result = await rankAndExplain({ candidates, constraints }, client);

    expect(result.ok && result.ranking.map((entry) => entry.id)).toEqual([STEW]);
    expect(result.ok && result.dropped).toEqual([INVENTED]);
  });

  it("records an invented id the model listed past the shortlist cut", async () => {
    const many = Array.from({ length: MAX_RESULTS }, (_, i) =>
      candidate(`5555555${i}-eeee-4555-8555-55555555abcd`, `Recipe ${i}`),
    );
    const { client } = stub({
      stop_reason: "end_turn",
      parsed_output: ranked(...many.map((row) => row.id), INVENTED),
    });

    const result = await rankAndExplain({ candidates: many, constraints }, client);

    expect(result.ok && result.ranking.map((entry) => entry.id)).toEqual(
      many.map((row) => row.id),
    );
    expect(result.ok && result.dropped).toEqual([INVENTED]);
  });

  it("doesn't record a duplicate, or a real id cut by MAX_RESULTS, as invented", async () => {
    const many = Array.from({ length: MAX_RESULTS + 1 }, (_, i) =>
      candidate(`6666666${i}-ffff-4666-8666-66666666abcd`, `Recipe ${i}`),
    );
    const ids = many.map((row) => row.id);
    const { client } = stub({
      stop_reason: "end_turn",
      parsed_output: ranked(ids[0], ...ids),
    });

    const result = await rankAndExplain({ candidates: many, constraints }, client);

    expect(result.ok && result.ranking).toHaveLength(MAX_RESULTS);
    expect(result.ok && result.dropped).toEqual([]);
  });

  it("matches ids case-insensitively and re-emits the candidate's own spelling", async () => {
    const { client } = stub({
      stop_reason: "end_turn",
      parsed_output: ranked(STEW.toUpperCase()),
    });

    const result = await rankAndExplain({ candidates, constraints }, client);

    expect(result.ok && result.ranking.map((entry) => entry.id)).toEqual([STEW]);
  });

  it("keeps a duplicated id once, at its first position", async () => {
    const { client } = stub({
      stop_reason: "end_turn",
      parsed_output: ranked(TRAYBAKE, CAULIFLOWER, TRAYBAKE),
    });

    const result = await rankAndExplain({ candidates, constraints }, client);

    expect(result.ok && result.ranking.map((entry) => entry.id)).toEqual([TRAYBAKE, CAULIFLOWER]);
  });

  it("truncates to MAX_RESULTS after dropping, so invented ids can't push out a real one", async () => {
    const many = Array.from({ length: MAX_RESULTS + 2 }, (_, i) =>
      candidate(`4444444${i}-dddd-4444-8444-44444444abcd`, `Recipe ${i}`),
    );
    const { client } = stub({
      stop_reason: "end_turn",
      parsed_output: ranked(INVENTED, ...many.map((row) => row.id)),
    });

    const result = await rankAndExplain({ candidates: many, constraints }, client);

    expect(result.ok && result.ranking.map((entry) => entry.id)).toEqual(
      many.slice(0, MAX_RESULTS).map((row) => row.id),
    );
  });

  it("returns no_candidates without calling the model", async () => {
    const { client, calls } = stub({ stop_reason: "end_turn", parsed_output: ranked(STEW) });

    expect(await rankAndExplain({ candidates: [], constraints }, client)).toEqual({
      ok: false,
      reason: "no_candidates",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a blank id as parse_failed, with no partial ranking", async () => {
    const { client } = stub({
      stop_reason: "end_turn",
      parsed_output: { ranking: [{ id: "   ", rationale: "Quick and uses what you have." }] },
    });

    expect(await rankAndExplain({ candidates, constraints }, client)).toEqual({
      ok: false,
      reason: "parse_failed",
    });
  });

  it("rejects an empty rationale as parse_failed", async () => {
    const { client } = stub({
      stop_reason: "end_turn",
      parsed_output: { ranking: [{ id: STEW, rationale: "" }] },
    });

    expect(await rankAndExplain({ candidates, constraints }, client)).toEqual({
      ok: false,
      reason: "parse_failed",
    });
  });

  it("treats missing parsed output as parse_failed", async () => {
    const { client } = stub({ stop_reason: "end_turn", parsed_output: null });

    expect(await rankAndExplain({ candidates, constraints }, client)).toEqual({
      ok: false,
      reason: "parse_failed",
    });
  });

  it("treats a refusal as refused", async () => {
    const { client } = stub({ stop_reason: "refusal", parsed_output: ranked(STEW) });

    expect(await rankAndExplain({ candidates, constraints }, client)).toEqual({
      ok: false,
      reason: "refused",
    });
  });

  it("treats a truncated response as parse_failed even when it parses", async () => {
    const { client } = stub({ stop_reason: "max_tokens", parsed_output: ranked(STEW) });

    expect(await rankAndExplain({ candidates, constraints }, client)).toEqual({
      ok: false,
      reason: "parse_failed",
    });
  });

  it("treats an API error as api_error", async () => {
    const { client } = stub(new APIConnectionError({ message: "socket hang up" }));

    expect(await rankAndExplain({ candidates, constraints }, client)).toEqual({
      ok: false,
      reason: "api_error",
    });
    expect(new APIConnectionError({ message: "x" })).toBeInstanceOf(APIError);
  });

  it("treats a non-JSON model response as parse_failed", async () => {
    const { client } = stub(new AnthropicError("Could not parse response content"));

    expect(await rankAndExplain({ candidates, constraints }, client)).toEqual({
      ok: false,
      reason: "parse_failed",
    });
  });

  it("lets an unexpected error propagate rather than reading as no ranking", async () => {
    const { client } = stub(new TypeError("boom"));

    await expect(rankAndExplain({ candidates, constraints }, client)).rejects.toThrow(TypeError);
  });

  it("shows the model every candidate id and no other", async () => {
    const { client, calls } = stub({ stop_reason: "end_turn", parsed_output: ranked(STEW) });

    await rankAndExplain({ candidates, constraints }, client);
    const sent = prompt(calls);

    // Every id in the payload, not just the absence of one invented constant.
    expect([...new Set(sent.match(UUID) ?? [])].sort()).toEqual(
      candidates.map((row) => row.id).sort(),
    );
  });

  it("names the violated terms only when the gate passes them", async () => {
    const clean = stub({ stop_reason: "end_turn", parsed_output: ranked(STEW) });
    await rankAndExplain({ candidates, constraints }, clean.client);
    expect(prompt(clean.calls)).not.toContain("creme fraiche");

    const retry = stub({ stop_reason: "end_turn", parsed_output: ranked(STEW) });
    await rankAndExplain({ candidates, constraints }, retry.client, ["creme fraiche", "butter"]);
    const sent = prompt(retry.calls);
    expect(sent).toContain("creme fraiche");
    expect(sent).toContain("butter");
  });
});
