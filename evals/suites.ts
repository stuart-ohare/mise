import type { AnySuite } from "./harness";
import { constraintExtraction } from "./suites/constraint-extraction";
import { recipeExtraction } from "./suites/recipe-extraction";

/** Every suite `pnpm eval` runs. */
export const suites: readonly AnySuite[] = [constraintExtraction, recipeExtraction];
