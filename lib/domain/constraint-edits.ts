import type { Constraints } from "./constraints";

/**
 * The edits the Cook screen can make to an extracted constraint set, as pure functions
 * (CLAUDE.md §6). They live here rather than in the component because one of them is a
 * safety decision: whether a hard exclusion may become a soft preference, and when it
 * may not. A disabled button is an affordance; this is the rule.
 */

/** The constraint fields a chip can come from. `maxMinutes` has no term list. */
export type ChipField = "exclude" | "avoid" | "have" | "maxMinutes";

/** A soft list a chip may be removed from outright. `exclude` is deliberately absent. */
export type RemovableField = "avoid" | "have";

export type Chip = {
  field: ChipField;
  /** The term as the cook said it. For `maxMinutes`, the limit as a string. */
  term: string;
  label: string;
  /** True only for `exclude`: filtered in SQL by gate 2, never a ranking weight. */
  hard: boolean;
  /** False when the chip's ✕ must refuse — an exclusion gate 1 could not map. */
  removable: boolean;
};

/**
 * Chips in the order they render: exclusions first, because the interface should tell
 * the same story as the architecture.
 */
export function chipsFor(constraints: Constraints, unresolved: readonly string[]): Chip[] {
  const chips: Chip[] = constraints.exclude.map((term) => ({
    field: "exclude" as const,
    term,
    label: `✗ ${term}`,
    hard: true,
    removable: !unresolved.includes(term),
  }));

  for (const term of constraints.avoid) {
    chips.push({ field: "avoid", term, label: `not: ${term}`, hard: false, removable: true });
  }
  for (const term of constraints.have) {
    chips.push({ field: "have", term, label: `has: ${term}`, hard: false, removable: true });
  }
  if (constraints.maxMinutes !== null) {
    chips.push({
      field: "maxMinutes",
      term: String(constraints.maxMinutes),
      label: `≤ ${constraints.maxMinutes} min`,
      hard: false,
      removable: true,
    });
  }

  return chips;
}

/**
 * Trade a hard exclusion down to a soft preference — the first of the two deliberate
 * acts it takes to stop filtering on a food.
 *
 * Refuses an unresolved term, and refuses one that was never excluded. Gate 2 filters on
 * a canonical id, so an exclusion gate 1 could not map has nothing behind it: demoting it
 * would move the term to a list that only weights ranking, leaving the cook looking at a
 * shortlist that was never filtered on the thing they asked to avoid. The refusal is here
 * rather than only in the disabled ✕ so it holds for every caller.
 *
 * `unresolved` is required, not defaulted: an omitted argument would fail open, which is
 * the one way this function can be wrong.
 */
export function demoteExclusion(
  constraints: Constraints,
  term: string,
  unresolved: readonly string[],
): Constraints {
  if (unresolved.includes(term) || !constraints.exclude.includes(term)) return constraints;

  return {
    ...constraints,
    exclude: constraints.exclude.filter((excluded) => excluded !== term),
    avoid: constraints.avoid.includes(term) ? constraints.avoid : [...constraints.avoid, term],
  };
}

/** Drop a term from a soft list. Unreachable for `exclude`, which `RemovableField` omits. */
export function removeTerm(
  constraints: Constraints,
  field: RemovableField,
  term: string,
): Constraints {
  return { ...constraints, [field]: constraints[field].filter((each) => each !== term) };
}

export function clearMaxMinutes(constraints: Constraints): Constraints {
  return { ...constraints, maxMinutes: null };
}

/**
 * The body a corrected chip posts. Typed structurally rather than as the route's
 * `CookRequest` so `lib/domain` keeps importing nothing from `app/`; the test parses the
 * result against the route's own schema, which is what actually pins the two together.
 */
export function nextRequest(constraints: Constraints): {
  kind: "constraints";
  constraints: Constraints;
} {
  return { kind: "constraints", constraints };
}
