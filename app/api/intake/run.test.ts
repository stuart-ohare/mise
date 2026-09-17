import { describe, expect, it } from "vitest";

import { MODELS } from "@/lib/ai/client";
import { VERSION as EXTRACTION_VERSION } from "@/lib/ai/prompts/extract-recipe";
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
  const base: IntakeDeps = {
    extract: () => Promise.resolve({ ok: true, draft: extracted }),
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
  return { deps: { ...base, ...over }, writes };
}

const run = (over: Partial<IntakeDeps> = {}, raw = "beans on toast") => {
  const { deps: d, writes } = deps(over);
  return runIntake({ sourceKind: "text", raw }, d).then((response) => ({ response, writes }));
};

describe("runIntake", () => {
  it("writes a draft whose unresolved line kept its raw text, and says which line it was", async () => {
    const { response, writes } = await run();

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
