import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// /approve adds status:planned, the human's plan approval (ADR 0003). If the model
// could invoke it, the skill would be a route to approving its own plan.

const APPROVE = resolve(__dirname, "../../.claude/skills/approve/SKILL.md");

function frontmatter(path: string): string {
  if (!existsSync(path)) return "";
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, "utf8"));
  return match?.[1] ?? "";
}

describe("/approve skill", () => {
  it("exists", () => {
    expect(existsSync(APPROVE)).toBe(true);
  });

  it("can only be started by the user", () => {
    const lines = frontmatter(APPROVE).split("\n");
    expect(lines).toContain("name: approve");
    expect(lines).toContain("disable-model-invocation: true");
  });
});
