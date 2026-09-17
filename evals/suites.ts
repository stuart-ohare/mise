import type { AnySuite } from "./harness";
import { constraintExtraction } from "./suites/constraint-extraction";

/** Every suite `pnpm eval` runs. */
export const suites: readonly AnySuite[] = [constraintExtraction];
