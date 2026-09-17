import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// gate-fixtures.sh is the §4.2 rule for gate-labelled issues: each labelled gate needs
// an added or modified test or fixture that declares it. Each case builds a real git
// repo — base commit, then a head commit — so the script's diff is real and offline.

const SCRIPT = resolve(__dirname, "gate-fixtures.sh");

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

function check(base: string, ...gates: string[]) {
  const result = spawnSync("bash", [SCRIPT, base, ...gates], { cwd: repo, env, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

let base: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mise-gate-fixtures-"));
  git("init", "-q", "-b", "main");
  write("README.md", "base\n");
  base = commit("base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const tag = (...names: string[]) => `// @gate ${names.join(" ")}\n`;

describe("gate-fixtures.sh", () => {
  it("fails a gate with only an untagged changed test, naming the gate", () => {
    write("lib/x.test.ts", "it('x', () => {});\n");
    commit("head");

    const result = check(base, "query");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/gate:query/);
  });

  it("passes when a changed test is tagged for the gate", () => {
    write("lib/x.test.ts", `${tag("query")}it('x', () => {});\n`);
    commit("head");

    expect(check(base, "query").status).toBe(0);
  });

  it("accepts a JSON eval fixture's gates field", () => {
    write("evals/fixtures/a.json", JSON.stringify({ gates: ["output"], query: "no dairy" }));
    commit("head");

    expect(check(base, "output").status).toBe(0);
  });

  it("fails when only one of two labelled gates is tagged, naming the missing one", () => {
    write("lib/x.test.ts", tag("query"));
    commit("head");

    const result = check(base, "query", "output");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/gate:output/);
    expect(result.stderr).not.toMatch(/gate:query/);
  });

  it("doesn't count a deleted tagged file", () => {
    write("lib/x.test.ts", tag("query"));
    const withTagged = commit("tagged");
    git("rm", "-q", "lib/x.test.ts");
    commit("delete");

    const result = check(withTagged, "query");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/gate:query/);
  });

  it("fails on an unknown gate name", () => {
    write("lib/x.test.ts", tag("querry"));
    commit("head");

    const result = check(base, "query");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown gate.*querry/i);
  });

  // Review finding: typos only failed on gate-labelled issues, so they surfaced one PR late.
  it("fails on an unknown gate name even when the issue has no gate labels", () => {
    write("lib/x.test.ts", tag("querry"));
    commit("head");

    const result = check(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown gate.*querry/i);
  });

  it("fails on an unknown gate label", () => {
    write("lib/x.test.ts", tag("query"));
    commit("head");

    const result = check(base, "foo");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/gate:foo/);
  });

  it("reads each JSON gates entry as one name", () => {
    write("evals/fixtures/a.json", JSON.stringify({ gates: ["query output"] }));
    commit("head");

    const result = check(base, "query");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown gate 'query output'/);
  });

  it("passes untagged changes when the issue has no gate labels", () => {
    write("lib/x.test.ts", "it('x', () => {});\n");
    commit("head");

    expect(check(base).status).toBe(0);
  });

  it("doesn't count a tag on a file this change didn't touch", () => {
    write("lib/old.test.ts", tag("query"));
    const withOld = commit("old tagged test");
    write("lib/new.test.ts", "it('x', () => {});\n");
    commit("head");

    const result = check(withOld, "query");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/gate:query/);
  });

  it("lets one file declare several gates", () => {
    write("lib/x.test.ts", tag("query", "output"));
    commit("head");

    expect(check(base, "query", "output").status).toBe(0);
  });

  it("fails on a malformed JSON fixture, naming the file", () => {
    write("evals/fixtures/broken.json", "{not json");
    commit("head");

    const result = check(base, "output");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/evals\/fixtures\/broken\.json/);
  });
});
