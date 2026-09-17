import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Git hooks see git's real state — the branch, the refs being pushed, the final
// message — so these tests drive real commits and pushes rather than parsed strings.

const GITHOOKS = resolve(__dirname, "../../.githooks");

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

let root: string;
let repo: string;

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

function commit(message: string, file = "f.txt") {
  writeFileSync(join(repo, file), `${Math.random()}`);
  git("add", file);
  return git("commit", "-m", message);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mise-githooks-"));
  repo = join(root, "repo");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", join(root, "origin.git")], { env });
  spawnSync("git", ["init", "-q", "-b", "main", repo], { env });
  // Seed main without hooks, as a clone of an existing repo would have it.
  commit("Initial commit");
  git("remote", "add", "origin", join(root, "origin.git"));
  git("push", "-q", "origin", "main");
  git("config", "core.hooksPath", GITHOOKS);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pre-commit: no commits on main", () => {
  it("rejects a commit on main", () => {
    const result = commit("Fix thing (#7)");
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/main/);
  });

  it("rejects main commits however git is invoked", () => {
    writeFileSync(join(repo, "f.txt"), "x");
    const result = git("-c", "user.name=x", "commit", "-am", "Fix thing (#7)");
    expect(result.status).not.toBe(0);
  });

  it("allows a commit on an issue branch", () => {
    git("switch", "-q", "-c", "7-some-work");
    expect(commit("Fix thing (#7)").status).toBe(0);
  });
});

describe("commit-msg: subject format", () => {
  beforeEach(() => {
    git("switch", "-q", "-c", "7-some-work");
  });

  it("allows a 72-char subject with an issue reference", () => {
    const subject = `${"a".repeat(67)} (#7)`;
    expect(subject).toHaveLength(72);
    expect(commit(subject).status).toBe(0);
  });

  it("rejects a 73-char subject", () => {
    const result = commit(`${"a".repeat(68)} (#7)`);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/72/);
  });

  it("rejects a subject with no issue reference", () => {
    const result = commit("Fix thing");
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/#n/);
  });

  it("checks -am commits too", () => {
    writeFileSync(join(repo, "f.txt"), "changed");
    expect(git("commit", "-am", "Fix thing").status).not.toBe(0);
  });

  it("checks only the subject, not the body", () => {
    expect(commit(`Fix thing (#7)\n\n${"Long body line. ".repeat(10)}`).status).toBe(0);
  });

  it("allows git's own merge subjects", () => {
    git("switch", "-q", "-c", "7-other", "main");
    commit("Other work (#7)", "other.txt");
    git("switch", "-q", "7-some-work");
    commit("Some work (#7)", "some.txt");
    expect(git("merge", "--no-edit", "7-other").status).toBe(0);
  });
});

describe("pre-push: no pushes to main", () => {
  beforeEach(() => {
    git("switch", "-q", "-c", "7-some-work");
    commit("Fix thing (#7)");
  });

  it.each([
    ["origin", "HEAD:main"],
    ["origin", "7-some-work:refs/heads/main"],
    ["--force", "origin", "HEAD:main"],
  ])("rejects push %s %s", (...args) => {
    const result = git("push", ...args);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/main/);
  });

  it("allows pushing the issue branch", () => {
    expect(git("push", "-u", "origin", "7-some-work").status).toBe(0);
  });
});
