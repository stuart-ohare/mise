import { describe, expect, it } from "vitest";

import { MODELS } from "@/lib/ai/client";
import {
  VERSION as EXTRACTION_VERSION,
  type RecipeSource,
} from "@/lib/ai/prompts/extract-recipe";
import type { IntakeWrite } from "@/lib/db/drafts";
import type { DraftRecipe } from "@/lib/domain/intake-draft";

import { runIntake, type IntakeDeps } from "./run";
import { intakeResponseSchema } from "./schema";

/**
 * The wiring between call 2, gate 1 and the write. Each part is correct on its own; this
 * is the one place a slip defeats a correct gate — a line resolved against the wrong
 * index, or a draft written when nothing was extracted.
 */

const BUTTER = "11111111-1111-4111-8111-111111111111";

const extracted: DraftRecipe = {
  title: "Beans on toast, properly",
  serves: 2,
  minutes: 10,
  ingredients: [
    {
      rawText: "a knob of butter",
      name: "butter",
      qty: null,
      unit: null,
      optional: false,
      confidence: 0.6,
    },
    {
      rawText: "2 tbsp ghee",
      name: "ghee",
      qty: 2,
      unit: "tbsp",
      optional: false,
      confidence: 0.95,
    },
  ],
  steps: ["Warm the beans.", "Butter the toast."],
  confidence: { title: 0.9, serves: 0.7, minutes: 0.5 },
};

function deps(over: Partial<IntakeDeps> = {}) {
  const writes: IntakeWrite[] = [];
  // Captured, not ignored: what call 2 was handed is the only thing that differs
  // between the two paths, so it is the one thing a stub must not throw away.
  const sources: RecipeSource[] = [];
  const base: IntakeDeps = {
    extract: (source) => {
      sources.push(source);
      return Promise.resolve({ ok: true, draft: extracted });
    },
    loadTerms: () => Promise.resolve([{ term: "butter", canonicalId: BUTTER }]),
    loadTree: () =>
      Promise.resolve({
        nodes: [{ id: BUTTER, name: "butter", parentId: null, allergenTags: ["dairy"] }],
        aliases: [],
      }),
    writeDraft: (input) => {
      writes.push(input);
      return Promise.resolve({ jobId: "job-1", recipeId: "recipe-1" });
    },
  };
  return { deps: { ...base, ...over }, writes, sources };
}

const run = (over: Partial<IntakeDeps> = {}, raw = "beans on toast") => {
  const { deps: d, writes, sources } = deps(over);
  return runIntake({ sourceKind: "text", raw }, d).then((response) => ({
    response,
    writes,
    sources,
  }));
};

describe("runIntake", () => {
  it("writes a draft whose unresolved line kept its raw text, and says which line it was", async () => {
    const { response, writes, sources } = await run();

    expect(response.kind).toBe("draft");
    if (response.kind !== "draft") return;

    expect(response.draft.ingredients).toEqual([
      {
        canonicalId: BUTTER,
        canonicalName: "butter",
        rawText: "a knob of butter",
        qty: null,
        unit: null,
        optional: false,
        confidence: 0.6,
      },
      {
        canonicalId: null,
        canonicalName: null,
        rawText: "2 tbsp ghee",
        qty: 2,
        unit: "tbsp",
        optional: false,
        confidence: 0.95,
      },
    ]);
    expect(response.draft.unresolved).toEqual(["2 tbsp ghee"]);
    expect(response.draft.recipe.status).toBe("draft");
    expect(writes).toHaveLength(1);
    expect(sources).toEqual([{ kind: "text", text: "beans on toast" }]);
  });

  it("records the paste, the model and the prompt version on the job it writes", async () => {
    const { writes } = await run({}, "  beans on toast  ");

    // The paste is stored as typed, not as the trimmed string call 2 was given: the job
    // row is the record of what arrived.
    expect(writes[0]).toMatchObject({
      rawInput: "  beans on toast  ",
      model: MODELS.capable,
      promptVersion: EXTRACTION_VERSION,
      output: extracted,
    });
  });

  it("resolves through an alias, exactly as an exclusion would", async () => {
    const { response } = await run({
      loadTerms: () => Promise.resolve([{ term: "clarified butter", canonicalId: BUTTER }]),
      extract: () =>
        Promise.resolve({
          ok: true,
          draft: {
            ...extracted,
            ingredients: [{ ...extracted.ingredients[0], name: "Clarified Butter" }],
          },
        }),
    });

    expect(response.kind === "draft" && response.draft.ingredients[0]).toMatchObject({
      canonicalId: BUTTER,
      canonicalName: "butter",
    });
  });

  it("writes nothing when extraction fails, and names the reason", async () => {
    for (const reason of ["empty_input", "refused", "parse_failed", "api_error"] as const) {
      const { response, writes } = await run({
        extract: () => Promise.resolve({ ok: false, reason }),
      });

      expect(response).toEqual({ kind: "not_extracted", reason });
      expect(writes).toEqual([]);
    }
  });

  it("returns a response the boundary schema accepts", async () => {
    const { response } = await run();
    expect(intakeResponseSchema.safeParse(response).success).toBe(true);
  });
});

/**
 * The image path. What matters is not that vision works — that is the model's job and
 * the screenshot's — but that the branch cannot skip the index on its way past. A line
 * nobody can name is unresolved whether it was typed or photographed.
 */

// A 1×1 PNG: the smallest thing that is genuinely an image rather than a string that
// looks like one.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("runIntake, from a photograph", () => {
  // @gate resolution
  it("resolves an image draft through gate 1 and records the job as an image", async () => {
    const { deps: d, writes, sources } = deps();
    const response = await runIntake({ sourceKind: "image", raw: PIXEL }, d);

    // The branch that matters: a card must reach call 2 as an image block, not as a
    // 4 MiB base64 string in a text block. `RecipeSource` is a union, so a collapsed
    // branch would typecheck and cost a real, useless vision call to discover.
    expect(sources).toEqual([
      {
        kind: "image",
        mediaType: "image/png",
        data: PIXEL.slice("data:image/png;base64,".length),
      },
    ]);

    expect(response.kind).toBe("draft");
    if (response.kind !== "draft") return;

    // Gate 1 ran on the image branch: the known line resolved, the unknown one did not,
    // and the unknown one kept the text the model read off the card.
    expect(response.draft.ingredients.map((line) => line.canonicalId)).toEqual([BUTTER, null]);
    expect(response.draft.ingredients[1]).toMatchObject({
      canonicalId: null,
      canonicalName: null,
      rawText: "2 tbsp ghee",
    });
    expect(response.draft.unresolved).toEqual(["2 tbsp ghee"]);
    // And so the recipe stays where an unresolved line puts it (CLAUDE.md §2).
    expect(response.draft.recipe.status).toBe("draft");

    // The job says what it read, and keeps the photograph itself: raw_input is never
    // the only casualty of a path that only stores text.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ sourceKind: "image", rawInput: PIXEL });
  });
});
