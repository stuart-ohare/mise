import type { Thresholds } from "./harness";

// Set by consequence, not by what the model currently achieves (evals/README.md).
// Read-only for agents — CLAUDE.md §4.5.
export const thresholds = {} satisfies Thresholds;
