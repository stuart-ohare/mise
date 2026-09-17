import { describe, expect, it } from "vitest";

import { matchTerms, microF1, setExactMatch } from "./scorers";

describe("setExactMatch", () => {
  it("ignores order", () => {
    expect(setExactMatch(["nuts", "egg"], ["egg", "nuts"])).toBe(true);
  });

  it("ignores case, surrounding and repeated whitespace, and Unicode normalisation form", () => {
    expect(setExactMatch(["crème fraîche"], ["  CRÈME   FRAÎCHE "])).toBe(true);
  });

  it("fails on an extra actual term", () => {
    expect(setExactMatch(["dairy"], ["dairy", "butter"])).toBe(false);
  });

  it("fails on a missing term", () => {
    expect(setExactMatch(["nuts", "egg"], ["nuts"])).toBe(false);
  });

  it("passes when both are empty", () => {
    expect(setExactMatch([], [])).toBe(true);
  });

  it("accepts any listed spelling of one term", () => {
    expect(setExactMatch([["prawn", "prawns"]], ["prawns"])).toBe(true);
    expect(setExactMatch([["prawn", "prawns"]], ["prawn"])).toBe(true);
  });

  it("doesn't let one actual term fill two expected slots", () => {
    expect(setExactMatch([["egg", "eggs"], "egg"], ["egg"])).toBe(false);
  });

  it("counts a repeated actual term once, as gate 1 does", () => {
    expect(setExactMatch(["dairy"], ["dairy", "Dairy"])).toBe(true);
  });
});

describe("matchTerms", () => {
  it("counts true positives, false positives and false negatives", () => {
    expect(matchTerms(["a", "b", "c"], ["a", "b", "d"])).toEqual({ tp: 2, fp: 1, fn: 1 });
  });
});

describe("microF1", () => {
  it("is 1 for a perfect match", () => {
    expect(microF1([{ tp: 3, fp: 0, fn: 0 }])).toBe(1);
  });

  it("is 0 when nothing matches", () => {
    expect(microF1([{ tp: 0, fp: 2, fn: 2 }])).toBe(0);
  });

  it("sums counts across pairs before computing F1", () => {
    expect(microF1([{ tp: 2, fp: 0, fn: 1 }, { tp: 0, fp: 1, fn: 0 }])).toBeCloseTo(2 / 3);
  });

  it("is 1 when every pair has nothing expected and nothing returned", () => {
    expect(microF1([{ tp: 0, fp: 0, fn: 0 }, { tp: 0, fp: 0, fn: 0 }])).toBe(1);
  });

  it("is 1 over no pairs", () => {
    expect(microF1([])).toBe(1);
  });
});
