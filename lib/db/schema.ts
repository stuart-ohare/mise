import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The spine of the domain is `canonicalIngredient`. Exclusion, substitution and
 * dedupe are all joins through it. Allergens hang off the canonical ingredient,
 * never off a recipe — a recipe is dairy-free because none of its resolved
 * ingredients carry the dairy tag, which makes it derived rather than asserted.
 */

export const recipeStatus = pgEnum("recipe_status", ["draft", "published"]);
export const extractionStatus = pgEnum("extraction_status", [
  "pending",
  "awaiting_review",
  "promoted",
  "rejected",
]);
export const extractionSource = pgEnum("extraction_source", ["text", "image"]);

export const canonicalIngredient = pgTable(
  "canonical_ingredient",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Self-referencing: double cream -> cream -> dairy. Exclusion walks this tree.
    parentId: uuid("parent_id"),
    allergenTags: text("allergen_tags").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("canonical_ingredient_name_idx").on(t.name)],
);

export const ingredientAlias = pgTable(
  "ingredient_alias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canonicalId: uuid("canonical_id")
      .notNull()
      .references(() => canonicalIngredient.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    // "hand" | "extraction" — provenance matters when an alias turns out wrong.
    source: text("source").notNull().default("hand"),
  },
  (t) => [uniqueIndex("ingredient_alias_alias_idx").on(t.alias)],
);

export const recipe = pgTable("recipe", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  summary: text("summary"),
  minutes: integer("minutes"),
  serves: integer("serves"),
  status: recipeStatus("status").notNull().default("draft"),
  // Set when the draft came from Intake; null for seeded recipes.
  extractionJobId: uuid("extraction_job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recipeIngredient = pgTable(
  "recipe_ingredient",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipe.id, { onDelete: "cascade" }),
    // Null is a first-class state, not a failure to handle: an unresolved
    // ingredient blocks its recipe from leaving draft, because an unknown
    // ingredient is exactly where an allergen hides.
    canonicalId: uuid("canonical_id").references(() => canonicalIngredient.id),
    // Never discarded. Extraction is lossy; the original string is the audit trail.
    rawText: text("raw_text").notNull(),
    // The term resolution was attempted on — the seed's `name`, call 2's `name` — kept
    // so an alias added in review can re-resolve this line by exact lookup, rather than
    // by reading a food out of `raw_text`.
    name: text("name").notNull(),
    qty: numeric("qty"),
    unit: text("unit"),
    optional: boolean("optional").notNull().default(false),
  },
  (t) => [
    index("recipe_ingredient_recipe_idx").on(t.recipeId),
    index("recipe_ingredient_canonical_idx").on(t.canonicalId),
  ],
);

export const recipeStep = pgTable(
  "recipe_step",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipe.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("recipe_step_recipe_idx").on(t.recipeId)],
);

export const extractionJob = pgTable("extraction_job", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceKind: extractionSource("source_kind").notNull(),
  rawInput: text("raw_input").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  output: jsonb("output"),
  // Per-field, deliberately: a 0.9 on `serves` and a 0.9 on `contains butter`
  // are not the same thing, and the review screen shows them separately.
  fieldConfidence: jsonb("field_confidence"),
  status: extractionStatus("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Gate 3. Every rejected generation is a counted, inspectable event rather than
 * a swallowed error — the count is the evidence the gate is load-bearing.
 */
export const outputViolation = pgTable("output_violation", {
  id: uuid("id").primaryKey().defaultRandom(),
  query: text("query").notNull(),
  excluded: text("excluded").array().notNull(),
  matchedTerm: text("matched_term").notNull(),
  generated: text("generated").notNull(),
  promptVersion: text("prompt_version").notNull(),
  retrySucceeded: boolean("retry_succeeded").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const canonicalIngredientRelations = relations(
  canonicalIngredient,
  ({ one, many }) => ({
    parent: one(canonicalIngredient, {
      fields: [canonicalIngredient.parentId],
      references: [canonicalIngredient.id],
      relationName: "ingredient_tree",
    }),
    children: many(canonicalIngredient, { relationName: "ingredient_tree" }),
    aliases: many(ingredientAlias),
  }),
);

export const recipeRelations = relations(recipe, ({ one, many }) => ({
  ingredients: many(recipeIngredient),
  steps: many(recipeStep),
  // Null for a seeded recipe. There is no foreign key behind it, so a recipe can outlive
  // its job; a read has to allow for the job being missing either way.
  extractionJob: one(extractionJob, {
    fields: [recipe.extractionJobId],
    references: [extractionJob.id],
  }),
}));

export const recipeIngredientRelations = relations(recipeIngredient, ({ one }) => ({
  recipe: one(recipe, {
    fields: [recipeIngredient.recipeId],
    references: [recipe.id],
  }),
  canonical: one(canonicalIngredient, {
    fields: [recipeIngredient.canonicalId],
    references: [canonicalIngredient.id],
  }),
}));
