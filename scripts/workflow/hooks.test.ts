import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The hooks are the only thing between an agent and a commit on main or a lowered
// eval threshold, so they're tested as the harness calls them: JSON on stdin,
// decision in the exit code (2 = deny) or a permissionDecision on stdout.

const HOOKS = resolve(__dirname, "../../.claude/hooks");

type HookResult = { status: number | null; stdout: string; stderr: string };

function runHook(script: string, input: object): HookResult {
  const result = spawnSync("bash", [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function asks(result: HookResult): boolean {
  return result.status === 0 && result.stdout.includes('"permissionDecision":"ask"');
}

function bash(command: string, cwd: string): HookResult {
  return runHook("guard-bash.sh", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd,
  });
}

function edit(tool_name: string, tool_input: object): HookResult {
  return runHook("guard-edit.sh", {
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    cwd: "/repo",
  });
}

function heredocCommit(subject: string): string {
  return `git commit -m "$(cat <<'EOF'\n${subject}\n\nWhy it changed.\nEOF\n)"`;
}

let onMain: string;
let onBranch: string;

beforeAll(() => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });
  onMain = mkdtempSync(join(tmpdir(), "mise-hook-main-"));
  git(onMain, "init", "-q", "-b", "main");
  onBranch = mkdtempSync(join(tmpdir(), "mise-hook-branch-"));
  git(onBranch, "init", "-q", "-b", "7-some-work");
});

afterAll(() => {
  rmSync(onMain, { recursive: true, force: true });
  rmSync(onBranch, { recursive: true, force: true });
});

describe("guard-bash: no commits or pushes on main", () => {
  it("denies git commit on main", () => {
    const result = bash('git commit -m "Fix thing (#7)"', onMain);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/main/);
  });

  it("denies git push on main", () => {
    expect(bash("git push", onMain).status).toBe(2);
  });

  it("denies pushing a branch onto main from elsewhere", () => {
    expect(bash("git push origin HEAD:main", onBranch).status).toBe(2);
  });

  it("follows git -C into a repo on main", () => {
    expect(bash(`git -C ${onMain} commit -m "Fix thing (#7)"`, onBranch).status).toBe(2);
  });

  // Found live: `git -C $d commit` got through because $d can't be expanded before the
  // command runs, so the branch was unknown. Unknown must fail closed.
  it("denies when the target repo's branch can't be determined", () => {
    const result = bash('git -C $d commit -m "Probe (#3)"', onBranch);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/branch/);
  });

  it("allows commit and push on an issue branch", () => {
    expect(bash('git commit -m "Fix thing (#7)"', onBranch).status).toBe(0);
    expect(bash("git push -u origin 7-some-work", onBranch).status).toBe(0);
  });

  it("ignores non-git commands on main", () => {
    expect(bash("pnpm test", onMain).status).toBe(0);
  });
});

describe("guard-bash: commit subject format", () => {
  it("allows a 72-char subject with an issue reference", () => {
    const subject = `${"a".repeat(67)} (#7)`;
    expect(subject).toHaveLength(72);
    expect(bash(`git commit -m "${subject}"`, onBranch).status).toBe(0);
  });

  it("denies a 73-char subject", () => {
    const subject = `${"a".repeat(68)} (#7)`;
    const result = bash(`git commit -m "${subject}"`, onBranch);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/72/);
  });

  it("denies a subject with no issue reference", () => {
    const result = bash('git commit -m "Fix thing"', onBranch);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/#n/);
  });

  it("reads the subject from a heredoc message", () => {
    expect(bash(heredocCommit("Add gate 3 validator (#14)"), onBranch).status).toBe(0);
    expect(bash(heredocCommit("Add gate 3 validator"), onBranch).status).toBe(2);
  });

  // Found live: a message body mentioning "git -C path" was parsed as the -C target.
  it("ignores git syntax quoted inside a heredoc message body", () => {
    const command = `git commit -m "$(cat <<'EOF'\nFix hook (#3)\n\nAn unresolvable git -C path failed open.\nEOF\n)"`;
    expect(bash(command, onBranch).status).toBe(0);
  });

  it("reads the subject from single-quoted -m", () => {
    expect(bash("git commit -m 'Fix thing (#7)'", onBranch).status).toBe(0);
  });

  it("leaves amend --no-edit alone", () => {
    expect(bash("git commit --amend --no-edit", onBranch).status).toBe(0);
  });
});

describe("guard-bash: dependency changes ask first", () => {
  it.each(["pnpm add zod", "pnpm remove zod", "pnpm add -D vitest", "npm install left-pad"])(
    "asks on %s",
    (command) => {
      expect(asks(bash(command, onBranch))).toBe(true);
    },
  );

  it.each(["pnpm i", "pnpm install", "pnpm install --frozen-lockfile", "pnpm test"])(
    "allows %s",
    (command) => {
      const result = bash(command, onBranch);
      expect(result.status).toBe(0);
      expect(asks(result)).toBe(false);
    },
  );

  it("asks when package.json is rewritten from the shell", () => {
    expect(asks(bash("sed -i '' 's/zod/zed/' package.json", onBranch))).toBe(true);
  });
});

describe("guard-bash: eval thresholds are read-only", () => {
  it("denies writing thresholds from the shell", () => {
    expect(bash("sed -i '' 's/1.0/0.9/' evals/thresholds.ts", onBranch).status).toBe(2);
    expect(bash("echo x > evals/thresholds.ts", onBranch).status).toBe(2);
  });

  it("denies other write shapes aimed at thresholds", () => {
    expect(bash("cat new.ts | tee -a evals/thresholds.ts", onBranch).status).toBe(2);
    expect(bash("cp /tmp/lower.ts evals/thresholds.ts", onBranch).status).toBe(2);
    expect(bash("git checkout main -- evals/thresholds.ts", onBranch).status).toBe(2);
  });

  it("allows reading thresholds", () => {
    expect(bash("cat evals/thresholds.ts", onBranch).status).toBe(0);
    expect(bash("git diff evals/thresholds.ts 2>&1 | head", onBranch).status).toBe(0);
  });

  // Found live: a heredoc writing docs that *mention* the file was denied.
  it("allows writing a different file whose content mentions thresholds", () => {
    const command = "cat > docs/adr.md <<'EOF'\nWrites to `evals/thresholds.ts` are denied.\nEOF";
    expect(bash(command, onBranch).status).toBe(0);
  });

  it("allows writing a different file whose content mentions package.json", () => {
    const command = "cat > README.md <<'EOF'\nDependencies live in package.json.\nEOF";
    expect(asks(bash(command, onBranch))).toBe(false);
  });
});

describe("guard-edit", () => {
  it.each(["Edit", "Write", "MultiEdit"])("denies %s on evals/thresholds.ts", (tool) => {
    const result = edit(tool, { file_path: "/repo/evals/thresholds.ts" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/100%/);
  });

  it("asks when an edit touches package.json dependencies", () => {
    const result = edit("Edit", {
      file_path: "/repo/package.json",
      old_string: '"dependencies": {\n    "zod": "^4.6.5"',
      new_string: '"dependencies": {\n    "zod": "^4.7.0"',
    });
    expect(asks(result)).toBe(true);
  });

  it("allows package.json edits that leave dependencies alone", () => {
    const result = edit("Edit", {
      file_path: "/repo/package.json",
      old_string: '"lint": "eslint"',
      new_string: '"lint": "eslint --max-warnings 0"',
    });
    expect(result.status).toBe(0);
    expect(asks(result)).toBe(false);
  });

  it("asks on a whole-file Write of package.json", () => {
    expect(asks(edit("Write", { file_path: "/repo/package.json", content: "{}" }))).toBe(true);
  });

  it("allows unrelated edits", () => {
    expect(edit("Edit", { file_path: "/repo/lib/domain/constraints.ts" }).status).toBe(0);
  });
});
