import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// eval-report.sh answers one question for verify.sh: can this change move an eval result?
// If it can, evals/latest.md has to be regenerated; if it can't, demanding one prices a
// correct label in API credits (#66). Each case builds a real git repo — base commit,
// then a head commit — so the diff the script reads is real, offline, and model-free.

const SCRIPT = resolve(__dirname, "eval-report.sh");
const ROOT = resolve(__dirname, "../..");

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

let repo: string;

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commit(message: string) {
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", message);
  return git("rev-parse", "HEAD");
}

function check(base: string) {
  const result = spawnSync("bash", [SCRIPT, base], { cwd: repo, env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** One changed path, nothing else, against a fresh base. */
function changing(...paths: string[]) {
  for (const path of paths) write(path, `touched ${path}\n`);
  commit("head");
}

let base: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mise-eval-report-"));
  git("init", "-q", "-b", "main");
  write("README.md", "base\n");
  base = commit("base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("eval-report.sh", () => {
  // #56's shape: gate-1 logic, a tagged test, no eval input anywhere in the diff.
  it("doesn't require the report when no eval input changed", () => {
    changing("lib/domain/constraint-edits.ts", "lib/domain/constraint-edits.test.ts", "app/page.tsx");

    const result = check(base);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/not required/);
  });

  it("requires the report when a prompt changed, naming the path", () => {
    changing("lib/ai/prompts/extract-constraints.ts");

    const result = check(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/lib\/ai\/prompts\/extract-constraints\.ts/);
    expect(result.stderr).toMatch(/evals\/latest\.md/);
  });

  it("passes when a prompt changed and the report was regenerated", () => {
    changing("lib/ai/prompts/extract-constraints.ts", "evals/latest.md");

    const result = check(base);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/lib\/ai\/prompts\/extract-constraints\.ts/);
  });

  it("requires the report when an eval fixture changed", () => {
    changing("evals/fixtures/constraint-extraction/18-new.json");

    expect(check(base).status).not.toBe(0);
  });

  it("requires the report when the model client changed", () => {
    changing("lib/ai/client.ts");

    expect(check(base).status).not.toBe(0);
  });

  // The runner reads neither of these, and evals/latest.md must not trigger the rule it satisfies.
  it("ignores markdown and Vitest files beside the runner", () => {
    changing("evals/README.md", "evals/harness.test.ts", "lib/ai/prompts/README.md");

    const result = check(base);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/not required/);
  });

  it("names the rule it applied on both branches", () => {
    changing("app/page.tsx");
    expect(check(base).stdout).toMatch(/§4\.4/);

    const quiet = git("rev-parse", "HEAD");
    changing("evals/scorers.ts", "evals/latest.md");
    expect(check(quiet).stdout).toMatch(/§4\.4/);
  });
});

/**
 * The allowlist in eval-report.sh is static, so it can drift behind an import. This walks
 * what `pnpm eval` actually loads and fails here — offline, in `pnpm test` — rather than
 * letting verify.sh wave through a change to a module the scorers depend on.
 */
function evalClosure(): string[] {
  const seen = new Set<string>();

  const resolveSpec = (spec: string, from: string): string | null => {
    let path: string;
    if (spec.startsWith("@/")) path = resolve(ROOT, spec.slice(2));
    else if (spec.startsWith(".")) path = resolve(dirname(from), spec);
    else return null; // a package, not ours

    for (const candidate of [`${path}.ts`, `${path}.tsx`, join(path, "index.ts"), path]) {
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    }
    return null;
  };

  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
      const target = resolveSpec(match[1], file);
      if (target) walk(target);
    }
  };

  walk(resolve(ROOT, "evals/run.ts"));
  return [...seen].map((file) => relative(ROOT, file)).sort();
}

describe("eval-report.sh allowlist", () => {
  it("covers every module pnpm eval loads", () => {
    const missed = evalClosure().filter((path) => {
      changing(path);
      const required = check(base).status !== 0;
      git("reset", "-q", "--hard", base);
      return !required;
    });

    expect(missed).toEqual([]);
  });
});
