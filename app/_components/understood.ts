import type { Constraints } from "@/lib/domain/constraints";

import type { CookResponse } from "../api/cook/schema";

/**
 * What Mise understood, as one value: the constraint set and the exclusions gate 1 could
 * not map to a canonical ingredient.
 *
 * They are paired rather than stored separately because separating them is a fail-open.
 * `unresolved` only ever arrives on `needs_resolution`, so a screen that derives it from
 * whatever response it currently holds loses it the moment a later request fails — while
 * still holding constraints that contain the unresolved term. The chip for that term
 * would then offer to demote it, and demoting it drops the exclusion: gate 2 filters on a
 * canonical id, and `avoid` only weights the ranking prompt. Kept together, that state is
 * not representable.
 */
export type Understood = {
  constraints: Constraints;
  unresolved: string[];
};

/** The single derivation. `not_understood` carries no constraints, so there is nothing. */
export function understoodFrom(response: CookResponse): Understood | null {
  if (response.kind === "not_understood") return null;

  return {
    constraints: response.constraints,
    unresolved: response.kind === "needs_resolution" ? response.unresolved : [],
  };
}
