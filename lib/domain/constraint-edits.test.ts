// @gate resolution
import { describe, expect, it } from "vitest";

import { cookRequestSchema } from "@/app/api/cook/schema";

import type { Constraints } from "./constraints";
import {
  chipsFor,
  clearMaxMinutes,
  demoteExclusion,
  nextRequest,
  removeTerm,
} from "./constraint-edits";

// The worked example from the README, plus a second entry in every list so an
// assertion about order can actually fail. `ghee` is the term gate 1 could not map.
const constraints: Constraints = {
  exclude: ["dairy", "peanut", "ghee"],
  avoid: ["curry", "pasta"],
  have: ["cauliflower", "rice"],
  maxMinutes: 25,
};
const unresolved = ["ghee"];

describe("demoteExclusion", () => {
  it("moves the term from exclude to avoid, preserving the order of both lists", () => {
    expect(demoteExclusion(constraints, "dairy", unresolved)).toEqual({
      exclude: ["peanut", "ghee"],
      avoid: ["curry", "pasta", "dairy"],
      have: ["cauliflower", "rice"],
      maxMinutes: 25,
    });
  });

  it("does not duplicate a term already in avoid", () => {
    const alsoAvoided: Constraints = { ...constraints, avoid: ["curry", "dairy"] };

    expect(demoteExclusion(alsoAvoided, "dairy", unresolved)).toEqual({
      exclude: ["peanut", "ghee"],
      avoid: ["curry", "dairy"],
      have: ["cauliflower", "rice"],
      maxMinutes: 25,
    });
  });

  // The one that matters. An exclusion Mise could not map to a canonical ingredient
  // cannot be traded down to a ranking weight: nothing downstream would filter on it,
  // so demoting it would silently drop the exclusion the cook actually stated.
  it("returns the constraints unchanged for an unresolved term", () => {
    expect(demoteExclusion(constraints, "ghee", unresolved)).toEqual(constraints);
  });

  it("returns the constraints unchanged for a term that is not excluded", () => {
    expect(demoteExclusion(constraints, "curry", unresolved)).toEqual(constraints);
  });
});

describe("removeTerm", () => {
  it("drops a term from avoid without touching exclude", () => {
    const alsoExcluded: Constraints = { ...constraints, avoid: ["curry", "dairy"] };

    expect(removeTerm(alsoExcluded, "avoid", "dairy")).toEqual({
      exclude: ["dairy", "peanut", "ghee"],
      avoid: ["curry"],
      have: ["cauliflower", "rice"],
      maxMinutes: 25,
    });
  });

  it("drops a term from have without touching exclude", () => {
    expect(removeTerm(constraints, "have", "cauliflower")).toEqual({
      exclude: ["dairy", "peanut", "ghee"],
      avoid: ["curry", "pasta"],
      have: ["rice"],
      maxMinutes: 25,
    });
  });
});

describe("clearMaxMinutes", () => {
  it("sets maxMinutes to null and changes nothing else", () => {
    expect(clearMaxMinutes(constraints)).toEqual({
      exclude: ["dairy", "peanut", "ghee"],
      avoid: ["curry", "pasta"],
      have: ["cauliflower", "rice"],
      maxMinutes: null,
    });
  });
});

describe("chipsFor", () => {
  it("marks every exclude chip hard and every other chip soft", () => {
    const chips = chipsFor(constraints, unresolved);

    expect(chips.filter((chip) => chip.hard).map((chip) => chip.term)).toEqual([
      "dairy",
      "peanut",
      "ghee",
    ]);
    expect(chips.filter((chip) => !chip.hard).map((chip) => chip.label)).toEqual([
      "not: curry",
      "not: pasta",
      "has: cauliflower",
      "has: rice",
      "≤ 25 min",
    ]);
  });

  it("marks an unresolved exclude chip as not removable", () => {
    const chips = chipsFor(constraints, unresolved);

    expect(chips.find((chip) => chip.term === "ghee")).toEqual({
      field: "exclude",
      term: "ghee",
      label: "✗ ghee",
      hard: true,
      removable: false,
    });
    expect(chips.find((chip) => chip.term === "dairy")?.removable).toBe(true);
  });

  // resolveExclusions dedupes by normalised key and reports only the first spelling, so
  // a second casing of an unresolved term never appears in `unresolved`. Both chips must
  // still refuse: the refusal compares normalised, even though the edit matches exactly.
  it("refuses every casing of an unresolved term, not just the reported one", () => {
    const duplicated: Constraints = { ...constraints, exclude: ["ghee", "GHEE"] };
    const chips = chipsFor(duplicated, ["ghee"]);

    expect(chips.filter((chip) => chip.field === "exclude").map((chip) => chip.removable)).toEqual([
      false,
      false,
    ]);
    expect(demoteExclusion(duplicated, "GHEE", ["ghee"])).toEqual(duplicated);
  });

  it("omits the time chip when no limit was stated", () => {
    const chips = chipsFor({ ...constraints, maxMinutes: null }, unresolved);

    expect(chips.some((chip) => chip.field === "maxMinutes")).toBe(false);
  });
});

describe("nextRequest", () => {
  // The screen posts corrected constraints back through the same boundary the route
  // parses. If this drifts, a chip edit becomes a 400 rather than a new shortlist.
  it("produces a body that parses against the route's request schema", () => {
    const parsed = cookRequestSchema.safeParse(nextRequest(constraints));

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ kind: "constraints", constraints });
  });
});
