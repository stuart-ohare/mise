import { describe, expect, it } from "vitest";

import { isActive } from "./nav-active";

describe("isActive", () => {
  it("lights Cook only on the root itself, not on every route under it", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/review", "/")).toBe(false);
  });

  it("lights a section on itself and on anything beneath it", () => {
    expect(isActive("/review", "/review")).toBe(true);
    expect(isActive("/review/abc", "/review")).toBe(true);
  });

  it("matches on a segment boundary, not a string prefix", () => {
    expect(isActive("/reviewer", "/review")).toBe(false);
  });

  it("doesn't light an unrelated section", () => {
    expect(isActive("/intake", "/review")).toBe(false);
  });
});
