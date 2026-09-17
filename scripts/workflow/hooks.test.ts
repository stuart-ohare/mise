import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Claude Code PreToolUse hooks, tested as the harness calls them: JSON on stdin,
// decision in the exit code (2 = deny) or a permissionDecision on stdout.
// Git's own rules (branch, push target, message) live in .githooks — see
// githooks.test.ts. These hooks cover what git can't see: file writes by tools,
// dependency changes, and attempts to switch the git hooks off.

const HOOKS = resolve(__dirname, "../../.claude/hooks");

type HookResult = { status: number | null; stdout: string; stderr: string };

let noTools: string;

beforeAll(() => {
  noTools = mkdtempSync(join(tmpdir(), "mise-no-tools-"));
});

afterAll(() => {
  rmSync(noTools, { recursive: true, force: true });
});

function runHook(script: string, input: object, path = process.env.PATH): HookResult {
  const result = spawnSync("/bin/bash", [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, PATH: path },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function asks(result: HookResult): boolean {
  return result.status === 0 && result.stdout.includes('"permissionDecision":"ask"');
}

function allows(result: HookResult): boolean {
  return result.status === 0 && !asks(result);
}

function bash(command: string, path?: string): HookResult {
  return runHook(
    "guard-bash.sh",
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/repo" },
    path,
  );
}

function edit(tool_name: string, tool_input: object, path?: string): HookResult {
  return runHook(
    "guard-edit.sh",
    { hook_event_name: "PreToolUse", tool_name, tool_input, cwd: "/repo" },
    path,
  );
}

describe("fail closed without jq", () => {
  it("guard-bash denies everything", () => {
    const result = bash("ls", noTools);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/jq/);
  });

  it("guard-edit denies everything", () => {
    expect(edit("Write", { file_path: "/repo/evals/thresholds.ts" }, noTools).status).toBe(2);
  });
});

describe("guard-bash: git hooks can't be switched off", () => {
  it.each([
    'git commit --no-verify -m "Fix (#7)"',
    'git commit -n -m "Fix (#7)"',
    "git push --no-verify origin main",
    'git -c core.hooksPath=/dev/null commit -m "Fix (#7)"',
    "git config core.hooksPath /tmp/none",
    "git config --unset core.hooksPath",
    "rm -rf .githooks",
    // Second review: routes that switched the hooks off anyway.
    "chmod -x .githooks/pre-commit .githooks/commit-msg",
    "sed -i '' '/hooksPath/d' .git/config",
    'git config core.hooksPath .githooks && git -c core.hooksPath=/dev/null commit -m "x (#3)"',
    'git -c core.hooksPath= commit -m "x (#3)"',
    "git config unset core.hooksPath",
    'git commit "--no-verify" -m "x (#3)"',
    'git commit --no-verif -m "x (#3)"',
  ])("denies %s", (command) => {
    expect(bash(command).status).toBe(2);
  });

  it.each([
    "grep -rn core.hooksPath docs",
    "git config core.hooksPath ./.githooks",
    "gh pr view 5 --json body | grep -- --no-verify",
    'git commit -m "Handle -n flag in parser (#9)"',
  ])("allows (second review false positive) %s", (command) => {
    expect(allows(bash(command))).toBe(true);
  });

  it("allows installing the repo's own hooks", () => {
    expect(allows(bash("git config core.hooksPath .githooks"))).toBe(true);
  });

  // Found live: reading the setting inside a chained command was denied.
  it("allows reading the hooks path", () => {
    expect(allows(bash("pnpm i && git config core.hooksPath"))).toBe(true);
    expect(allows(bash("git config --get core.hooksPath"))).toBe(true);
  });

  it.each(['git commit -m "Fix (#7)"', "git push -u origin 7-some-work", "git log -n 5"])(
    "allows %s",
    (command) => {
      expect(allows(bash(command))).toBe(true);
    },
  );

  it("doesn't mistake message text for a flag", () => {
    const command = `git commit -m "$(cat <<'EOF'\nGuard --no-verify (#3)\nEOF\n)"`;
    expect(allows(bash(command))).toBe(true);
  });
});

describe("guard-bash: dependency changes ask first", () => {
  it.each([
    "pnpm add zod",
    "pnpm remove zod",
    "pnpm add -D vitest",
    "pnpm -D add zod",
    "pnpm --filter web add zod",
    "pnpm update zod",
    "npm install left-pad",
    "npm i -D left-pad",
    "npm install --save-dev left-pad",
  ])("asks on %s", (command) => {
    expect(asks(bash(command))).toBe(true);
  });

  it.each(["pnpm i", "pnpm install", "pnpm install --frozen-lockfile", "pnpm test"])(
    "allows %s",
    (command) => {
      expect(allows(bash(command))).toBe(true);
    },
  );

  it("asks when package.json is rewritten from the shell", () => {
    expect(asks(bash("sed -i '' 's/zod/zed/' package.json"))).toBe(true);
  });

  it("allows copying package.json elsewhere", () => {
    expect(allows(bash("cp package.json /tmp/package.backup.json"))).toBe(true);
  });
});

describe("guard-bash: protected files", () => {
  it.each([
    "sed -i '' 's/1.0/0.9/' evals/thresholds.ts",
    "sed -E -i '' 's/1.0/0.9/' evals/thresholds.ts",
    "echo x > evals/thresholds.ts",
    "cd evals && echo x > thresholds.ts",
    "echo x > Evals/Thresholds.ts",
    "cat new.ts | tee -a evals/thresholds.ts",
    "cp /tmp/lower.ts evals/thresholds.ts",
    "git checkout main -- evals/thresholds.ts",
  ])("denies threshold write: %s", (command) => {
    expect(bash(command).status).toBe(2);
  });

  it.each([
    "echo abc123 > .git/mise-verified",
    "git rev-parse HEAD > $(git rev-parse --git-dir)/mise-verified",
  ])("denies forging the verified record: %s", (command) => {
    expect(bash(command).status).toBe(2);
  });

  it.each([
    "cat evals/thresholds.ts",
    "git diff evals/thresholds.ts 2>&1 | head",
    "cp evals/thresholds.ts /tmp/backup.ts",
    "cat .git/mise-verified",
    "git restore --staged evals/thresholds.ts",
  ])("allows reading: %s", (command) => {
    expect(allows(bash(command))).toBe(true);
  });

  it("allows writing a different file whose content mentions thresholds", () => {
    const command = "cat > docs/adr.md <<'EOF'\nWrites to `evals/thresholds.ts` are denied.\nEOF";
    expect(allows(bash(command))).toBe(true);
  });

  it("allows writing a different file whose content mentions package.json", () => {
    const command = "cat > README.md <<'EOF'\nDependencies live in package.json.\nEOF";
    expect(allows(bash(command))).toBe(true);
  });

  it("doesn't treat a here-string as a heredoc", () => {
    expect(bash("cat <<< hi\necho x > evals/thresholds.ts").status).toBe(2);
  });

  it("handles heredoc delimiters with hyphens", () => {
    const command = "cat > a.md <<'END-OF'\ntext\nEND-OF\necho x > evals/thresholds.ts";
    expect(bash(command).status).toBe(2);
  });

  it("asks before rewriting the guards themselves", () => {
    expect(asks(bash("sed -i '' 's/exit 2/exit 0/' .claude/hooks/guard-bash.sh"))).toBe(true);
  });
});

describe("guard-bash: only the human approves a plan", () => {
  it.each([
    "gh issue edit 18 --remove-label status:spec --add-label status:planned",
    'gh issue edit 18 --add-label "status:planned"',
    'gh api -X POST repos/stuart-ohare/mise/issues/18/labels -f "labels[]=status:planned"',
    "gh issue edit 18 --add-label=status:planned",
    "gh issue edit 18 --add-label bug,status:planned",
    "gh issue create --title x --label status:planned",
    "gh issue view 18 && gh issue edit 18 --add-label status:planned",
  ])("asks on %s", (command) => {
    expect(asks(bash(command))).toBe(true);
  });

  it.each([
    "gh issue edit 18 --remove-label status:planned --add-label status:building",
    "gh issue edit 18 --add-label status:spec",
    "gh issue view 18 --json labels",
    "gh issue comment 18 --body-file plan.md",
    "gh issue list --label status:planned",
  ])("allows %s", (command) => {
    expect(allows(bash(command))).toBe(true);
  });
});

describe("guard-edit", () => {
  it.each(["Edit", "Write", "MultiEdit"])("denies %s on evals/thresholds.ts", (tool) => {
    const result = edit(tool, { file_path: "/repo/evals/thresholds.ts" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/100%/);
  });

  it("denies a case-variant thresholds path", () => {
    expect(edit("Write", { file_path: "/repo/Evals/Thresholds.ts" }).status).toBe(2);
  });

  it("denies editing git config, where core.hooksPath lives", () => {
    expect(edit("Write", { file_path: "/repo/.git/config", content: "" }).status).toBe(2);
  });

  it("denies writing the verified record", () => {
    expect(edit("Write", { file_path: "/repo/.git/mise-verified", content: "abc" }).status).toBe(2);
  });

  it.each([
    "/repo/.githooks/pre-commit",
    "/repo/.claude/hooks/guard-bash.sh",
    "/repo/.claude/settings.json",
  ])("asks before editing guard file %s", (file_path) => {
    expect(asks(edit("Edit", { file_path, old_string: "a", new_string: "b" }))).toBe(true);
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
    expect(allows(result)).toBe(true);
  });

  it("asks on a whole-file Write of package.json", () => {
    expect(asks(edit("Write", { file_path: "/repo/package.json", content: "{}" }))).toBe(true);
  });

  it("allows unrelated edits", () => {
    expect(allows(edit("Edit", { file_path: "/repo/lib/domain/constraints.ts" }))).toBe(true);
  });
});
