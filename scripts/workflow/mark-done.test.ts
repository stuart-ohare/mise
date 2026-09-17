import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// mark-done.sh relabels the issues a merged PR closes. It's run here against a fake
// `gh` first on PATH — canned JSON in, every call recorded — so the logic is tested
// without the network (pnpm test makes no network calls, CLAUDE.md §5).

const SCRIPT = resolve(__dirname, "mark-done.sh");

type Pr = { state: string; closingIssuesReferences: { number: number }[] };

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mise-mark-done-"));
  log = join(dir, "gh.log");
  writeFileSync(log, "");
  const fakeGh = `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1 $2" in
  "pr view")
    [[ -f "${dir}/pr-fails" ]] && { echo "gh: not found" >&2; exit 1; }
    cat "${dir}/pr.json" ;;
  "issue view") cat "${dir}/issue-$3.json" ;;
  "issue edit") ;;
  *) echo "unexpected gh call: $*" >&2; exit 64 ;;
esac
`;
  writeFileSync(join(dir, "gh"), fakeGh);
  chmodSync(join(dir, "gh"), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function givenPr(pr: Pr) {
  writeFileSync(join(dir, "pr.json"), JSON.stringify(pr));
}

function givenIssue(n: number, labels: string[]) {
  writeFileSync(join(dir, `issue-${n}.json`), JSON.stringify({ labels: labels.map((name) => ({ name })) }));
}

function markDone(pr = "42") {
  return spawnSync("bash", [SCRIPT, pr], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

type Edit = { issue: string; removed: string[]; added: string[] };

function edits(): Edit[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("issue edit "))
    .map((line) => {
      const args = line.split(" ").slice(2);
      const values = (flag: string) =>
        args.flatMap((arg, i) => (arg === flag ? args[i + 1].split(",") : []));
      return { issue: args[0], removed: values("--remove-label"), added: values("--add-label") };
    });
}

describe("mark-done.sh", () => {
  it("moves the closing issue from its status to status:done", () => {
    givenPr({ state: "MERGED", closingIssuesReferences: [{ number: 7 }] });
    givenIssue(7, ["status:in-review"]);

    expect(markDone().status).toBe(0);
    expect(edits()).toEqual([{ issue: "7", removed: ["status:in-review"], added: ["status:done"] }]);
  });

  it("relabels every issue a PR closes, each by its own labels", () => {
    givenPr({ state: "MERGED", closingIssuesReferences: [{ number: 7 }, { number: 8 }] });
    givenIssue(7, ["status:in-review"]);
    givenIssue(8, ["status:building"]);

    expect(markDone().status).toBe(0);
    expect(edits()).toEqual([
      { issue: "7", removed: ["status:in-review"], added: ["status:done"] },
      { issue: "8", removed: ["status:building"], added: ["status:done"] },
    ]);
  });

  it("removes every status label but never a gate label", () => {
    givenPr({ state: "MERGED", closingIssuesReferences: [{ number: 7 }] });
    givenIssue(7, ["status:spec", "gate:query", "status:in-review"]);

    markDone();
    const [edit] = edits();
    expect(edit.removed.sort()).toEqual(["status:in-review", "status:spec"]);
    expect(edit.removed).not.toContain("gate:query");
    expect(edit.added).toEqual(["status:done"]);
  });

  it("is idempotent for an issue already marked done", () => {
    givenPr({ state: "MERGED", closingIssuesReferences: [{ number: 7 }] });
    givenIssue(7, ["status:done"]);

    expect(markDone().status).toBe(0);
    const [edit] = edits();
    expect(edit.removed).toEqual([]);
    expect(edit.added).toEqual(["status:done"]);
  });

  it("changes nothing when the PR closes no issues", () => {
    givenPr({ state: "MERGED", closingIssuesReferences: [] });

    expect(markDone().status).toBe(0);
    expect(edits()).toEqual([]);
  });

  it("changes nothing when the PR was closed without merging", () => {
    givenPr({ state: "CLOSED", closingIssuesReferences: [{ number: 7 }] });
    givenIssue(7, ["status:in-review"]);

    expect(markDone().status).toBe(0);
    expect(edits()).toEqual([]);
  });

  // Review finding: a jq failure in a for-loop word list escaped set -e and exited 0.
  it("fails loudly when the closing references can't be read", () => {
    writeFileSync(join(dir, "pr.json"), '{"state":"MERGED","closingIssuesReferences":"oops"}');

    const result = markDone();
    expect(result.status).not.toBe(0);
    expect(edits()).toEqual([]);
  });

  it("fails loudly when gh fails, so a missed relabel shows as a red run", () => {
    writeFileSync(join(dir, "pr-fails"), "");

    const result = markDone();
    expect(readFileSync(log, "utf8")).toMatch(/^pr view 42/m);
    expect(result.status).not.toBe(0);
    expect(edits()).toEqual([]);
  });
});
