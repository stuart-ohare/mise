---
name: plan
description: Write an implementation plan for a filed Mise issue, post it as an issue comment, and stop for human approval. Second step of the loop. Use for "/plan <n>" or "plan issue <n>".
---

# /plan <n> — issue → plan awaiting approval

## 1. Preconditions

```bash
gh issue view <n> --json state,labels,body,comments
```

- The issue must be open and labelled `status:spec`. If it's already `status:planned`
  or later, say so and stop.
- If acceptance criteria aren't observable, or the gate question is unanswered, send the
  user back to `/spec` rather than guessing.

## 2. Investigate

Read every file the change will touch, the relevant ADRs, and — if the issue carries a
`gate:*` label — the existing tests/fixtures for that gate. Check
`node_modules/next/dist/docs/` for any Next.js API you plan to use (AGENTS.md).

## 3. Write the plan

Post as a single issue comment headed `## Plan`:

- **Files** — table of path → purpose. Every file created or changed.
- **Failing test or fixture first** — exactly which Vitest case or eval fixture will be
  written before implementation, and what it asserts (§4.2). For `gate:*` issues this
  is mandatory and must exercise the exclusion behaviour.
- **Decisions inside the design** — anything the spec left open that you're choosing.
- **Verification evidence** — what the PR will show for each acceptance criterion.
- **Risks / stop-and-ask** — any §4.5 condition you expect to hit.

Smallest change that satisfies the criteria. Adjacent refactors become new issues.

```bash
gh issue comment <n> --body-file <plan>
```

## 4. Stop

Tell the user:

> Plan posted: <comment url>. To approve, run `/approve <n>` and accept the prompt
> (or move the label yourself: `gh issue edit <n> --remove-label status:spec --add-label status:planned`).
> Then run `/build <n>`.

**Never add `status:planned` yourself**, even if the user says "approved" in chat —
ask them to run `/approve <n>`. The label is the approval record (ADR 0003). If they want
changes, edit the plan by posting a `## Plan amendment` comment, not by rewriting history.
