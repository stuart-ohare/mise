---
name: spec
description: Turn a rough idea into an approved GitHub issue by grilling the user one question at a time. First step of the Mise loop (spec → plan → build → verify → ship). Use when the user wants to start new work, file an issue, or says "/spec <idea>".
---

# /spec — idea → approved issue

CLAUDE.md §4.1: no issue, no branch. This skill produces the issue.

## 1. Explore before asking

Read what the idea touches: `CLAUDE.md`, relevant ADRs in `docs/decisions/`, the code
under the affected paths, and `gh issue list --state all` for overlap. Never ask the
user something the repo can answer.

## 2. Grill

Interview relentlessly until the design is unambiguous. Rules:

- **One question at a time**, with `AskUserQuestion`. Each option explains its
  trade-off; put your recommendation first, marked "(Recommended)".
- Walk the decision tree depth-first: resolve a decision's dependents before moving on.
- State obvious defaults instead of asking about them.
- Always settle, explicitly:
  - **Which gate(s)** this touches (resolution / query / output), or none — and why.
    If the change touches `lib/domain/`, exclusion SQL, the output validator,
    `lib/ai/prompts/` or `evals/`, "none" needs a reason.
  - **Observable acceptance criteria** — each one checkable with a command, test name, or screenshot. Never "works correctly".
  - **Scope cut** — what is explicitly out, and whether it wants its own issue.
  - Any §4.5 stop-and-ask condition (weakened gate, lowered threshold, deliberately-absent item, new dependency, real spend). Raise these; don't design around them.

Stop grilling when you could write the issue without inventing anything.

## 3. Draft and get approval

Show the full draft in chat using `.github/ISSUE_TEMPLATE/work.md`'s headings:
What changes (one sentence) / Design / Acceptance criteria / Invariant / gates touched / Out of scope.

**Do not file until the user explicitly approves.** Filing is the record of spec approval.

## 4. File

```bash
gh issue create --title "<imperative title>" --body-file <draft> \
  --label status:spec [--label gate:resolution|gate:query|gate:output ...]
```

If work splits into several issues, file them all and cross-link the numbers.

Report the issue URL and tell the user the next step is `/plan <n>`.
