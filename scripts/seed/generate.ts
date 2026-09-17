import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "dotenv";

import { anthropic, MODELS } from "@/lib/ai/client";
import {
  BATCH_BRIEFS,
  batchPrompt,
  catalogueBatchSchema,
  DELIBERATELY_UNRESOLVED,
  leavesSchema,
  RECIPES_PER_BATCH,
  recipesSchema,
  SYSTEM,
  VERSION,
  type CatalogueBatch,
  type Leaf,
  type Recipe,
} from "@/lib/ai/prompts/seed-catalogue";
import { buildNameIndex, resolveTerm } from "@/lib/domain/resolution";
import { taxonomySchema, validateTaxonomy, type TaxonomyNode } from "@/lib/domain/taxonomy";

/**
 * One-off: generates `recipes.json` and `leaves.json` with the capable model. Costs
 * money and is not part of `pnpm seed`. Run with `pnpm tsx scripts/seed/generate.ts`.
 *
 * Each batch is validated against everything generated so far and gets one retry with
 * the errors fed back. Nothing is written unless every batch passes.
 * `scripts/seed/catalogue.test.ts` is the final check on what was written.
 */

config({ path: ".env.local", quiet: true });

const MAX_TOKENS = 20_000;
const unresolvedByDesign: readonly string[] = DELIBERATELY_UNRESOLVED;
const normalise = (s: string) => s.trim().toLowerCase();

type Catalogue = { recipes: Recipe[]; leaves: Leaf[] };

function merge(taxonomy: readonly TaxonomyNode[], sofar: Catalogue, batch: CatalogueBatch): Catalogue | string[] {
  const errors: string[] = [];

  const leaves = [...sofar.leaves];
  for (const raw of batch.leaves) {
    const name = normalise(raw.name);
    const parent = raw.parent === null ? null : normalise(raw.parent);
    if (unresolvedByDesign.includes(name)) {
      errors.push(`leaf "${name}" must not exist: it is deliberately unresolved`);
      continue;
    }
    const existing = leaves.find((l) => l.name === name);
    if (existing) {
      if (existing.parent !== parent) {
        errors.push(`leaf "${name}" already exists under ${existing.parent ?? "no parent"}, not ${parent ?? "no parent"}`);
      }
      continue;
    }
    leaves.push({ name, parent, allergenTags: [], aliases: [] });
  }

  const tree = validateTaxonomy({ nodes: [...taxonomy, ...leaves] });
  if (!tree.ok) errors.push(...tree.errors);

  const candidate = {
    recipes: [
      ...sofar.recipes,
      ...batch.recipes.map((r) => ({
        ...r,
        ingredients: r.ingredients.map((i) => ({ ...i, name: normalise(i.name) })),
      })),
    ],
  };
  const parsed = recipesSchema.safeParse(candidate);
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  if (errors.length > 0 || !parsed.success) return errors;

  const index = buildNameIndex(
    [...taxonomy, ...leaves].flatMap((n) => [n.name, ...n.aliases].map((term) => ({ term, id: n.name }))),
  );
  for (const recipe of parsed.data.recipes) {
    for (const ingredient of recipe.ingredients) {
      if (resolveTerm(ingredient.name, index) === null && !unresolvedByDesign.includes(ingredient.name)) {
        errors.push(`"${recipe.title}": ingredient "${ingredient.name}" is not a taxonomy term or a defined leaf`);
      }
    }
  }
  if (batch.recipes.length !== RECIPES_PER_BATCH) {
    errors.push(`expected ${RECIPES_PER_BATCH} recipes, got ${batch.recipes.length}`);
  }
  return errors.length > 0 ? errors : { recipes: parsed.data.recipes, leaves };
}

async function generateBatch(
  taxonomy: readonly TaxonomyNode[],
  sofar: Catalogue,
  brief: string,
): Promise<Catalogue> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: batchPrompt({
        taxonomy,
        leaves: sofar.leaves,
        existing: sofar.recipes,
        count: RECIPES_PER_BATCH,
        brief,
      }),
    },
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const message = await anthropic().messages.parse({
      model: MODELS.capable,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages,
      output_config: { format: zodOutputFormat(catalogueBatchSchema) },
    });
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    const usage = `${message.usage.input_tokens} in / ${message.usage.output_tokens} out`;

    if (message.stop_reason !== "end_turn" || message.parsed_output === null) {
      throw new Error(`batch stopped with ${message.stop_reason} (${usage}); raise MAX_TOKENS or shrink the batch`);
    }

    const result = merge(taxonomy, sofar, message.parsed_output);
    if (!Array.isArray(result)) {
      console.log(`  attempt ${attempt}: ok (${usage})`);
      return result;
    }

    console.log(`  attempt ${attempt}: ${result.length} problems (${usage})`);
    for (const error of result) console.log(`    ${error}`);
    messages.push(
      { role: "assistant", content: text },
      {
        role: "user",
        content: `That batch has these problems:\n${result.map((e) => `- ${e}`).join("\n")}\n\nReturn the whole batch again, corrected.`,
      },
    );
  }
  throw new Error("batch still invalid after a retry; fix the prompt and bump VERSION rather than retrying blind");
}

async function main(): Promise<void> {
  const taxonomy = taxonomySchema.parse(
    JSON.parse(readFileSync(resolve(__dirname, "taxonomy.json"), "utf8")),
  );
  const tree = validateTaxonomy(taxonomy);
  if (!tree.ok) throw new Error(`taxonomy.json is invalid:\n${tree.errors.join("\n")}`);

  console.log(`Generating with ${MODELS.capable}, seed-catalogue prompt VERSION ${VERSION}`);
  let catalogue: Catalogue = { recipes: [], leaves: [] };
  for (const [i, brief] of BATCH_BRIEFS.entries()) {
    console.log(`Batch ${i + 1}/${BATCH_BRIEFS.length}`);
    catalogue = await generateBatch(tree.nodes, catalogue, brief);
  }

  // Keep only leaves a recipe uses, or that another kept leaf hangs under.
  const used = new Set(catalogue.recipes.flatMap((r) => r.ingredients.map((i) => i.name)));
  const byName = new Map(catalogue.leaves.map((l) => [l.name, l]));
  for (const name of [...used]) {
    for (let parent = byName.get(name)?.parent; parent; parent = byName.get(parent)?.parent) used.add(parent);
  }
  const leaves = leavesSchema.parse({ nodes: catalogue.leaves.filter((l) => used.has(l.name)) });
  const recipes = recipesSchema.parse({ recipes: catalogue.recipes });

  writeFileSync(resolve(__dirname, "recipes.json"), `${JSON.stringify(recipes, null, 2)}\n`);
  writeFileSync(resolve(__dirname, "leaves.json"), `${JSON.stringify(leaves, null, 2)}\n`);
  console.log(`Wrote ${recipes.recipes.length} recipes and ${leaves.nodes.length} leaves.`);

  const handTerms = taxonomy.nodes.flatMap((n) => [n.name, ...n.aliases]);
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const compounds = leaves.nodes.filter((l) =>
    handTerms.some((t) => new RegExp(`(^|[^\\p{L}])${escape(t)}($|[^\\p{L}])`, "u").test(l.name)),
  );
  if (compounds.length > 0) {
    console.log("Review by hand — leaf names containing a hand-authored term:");
    for (const l of compounds) console.log(`  ${l.name} (under ${l.parent ?? "no parent"})`);
  }
  console.log("Now run: pnpm vitest run scripts/seed/catalogue.test.ts");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
