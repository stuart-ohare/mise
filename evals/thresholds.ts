import type { Thresholds } from "./harness";

// Set by consequence, not by what the model currently achieves (evals/README.md).
// Read-only for agents — CLAUDE.md §4.5.

export const thresholds = {
  "constraint-extraction": {
    exclude_exact: 1,
    have_f1: 0.8,
    avoid_f1: 0.8,
    max_minutes_exact: 0.8,
  },
} satisfies Thresholds;
