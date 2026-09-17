// @gate query
import { describe, expect, it } from "vitest";

import { taxonomySchema, validateTaxonomy, type TaxonomyNode } from "./taxonomy";

function node(name: string, parent: string | null, aliases: string[] = []): TaxonomyNode {
  return { name, parent, allergenTags: parent === null ? ["dairy"] : [], aliases };
}

function errorsOf(nodes: TaxonomyNode[]): string[] {
  const result = validateTaxonomy({ nodes });
  return result.ok ? [] : result.errors;
}

describe("validateTaxonomy", () => {
  it("rejects a parent that doesn't exist", () => {
    const errors = errorsOf([node("dairy", null), node("butter", "dairyy")]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("butter");
    expect(errors[0]).toContain("dairyy");
  });

  it("rejects a cycle, even beside a valid root", () => {
    const errors = errorsOf([node("dairy", null), node("a", "b"), node("b", "a")]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/cycle/);
    expect(errors[0]).toContain("a");
    expect(errors[0]).toContain("b");
  });

  it("rejects a duplicate name, ignoring case", () => {
    const errors = errorsOf([node("dairy", null), node("butter", "dairy"), node("Butter", "dairy")]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("butter");
  });

  it("rejects the same alias on two nodes", () => {
    const errors = errorsOf([
      node("shellfish", null),
      node("prawn", "shellfish", ["prawns"]),
      node("shrimp", "shellfish", ["prawns"]),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("prawns");
  });

  it("rejects an alias that is another node's name", () => {
    // Gate 1 resolves against names and aliases together, so an alias shadowing a
    // name would make the same term mean two ingredients.
    const errors = errorsOf([
      node("dairy", null),
      node("cream", "dairy"),
      node("butter", "dairy", ["cream"]),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("cream");
  });

  it("returns a valid tree parent-first", () => {
    const result = validateTaxonomy({
      nodes: [node("clarified butter", "butter"), node("butter", "dairy"), node("dairy", null)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const position = new Map(result.nodes.map((n, i) => [n.name, i]));
    for (const n of result.nodes) {
      if (n.parent === null) continue;
      expect(position.get(n.parent)).toBeLessThan(position.get(n.name) ?? -1);
    }
    expect(result.nodes).toHaveLength(3);
  });
});

describe("taxonomySchema", () => {
  it("rejects an allergen tag outside the six", () => {
    const parsed = taxonomySchema.safeParse({
      nodes: [{ name: "dairy", parent: null, allergenTags: ["diary"], aliases: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a name that isn't lowercase and trimmed", () => {
    // The database's unique indexes are case-sensitive; the file must not rely on them.
    const parsed = taxonomySchema.safeParse({
      nodes: [{ name: "Dairy ", parent: null, allergenTags: ["dairy"], aliases: [] }],
    });
    expect(parsed.success).toBe(false);
  });
});
