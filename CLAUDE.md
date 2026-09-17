# CLAUDE.md — Mise

Operating instructions for any agent (or human) working in this repository.
Read this file top to bottom before the first change of a session.

---

## 1. The invariant

> **An exclusion is never a model decision. It is a database constraint, and generated
> text is validated against it before it renders.**

Mise answers one question — *what can I actually cook right now* — for a household
where someone has a hard dietary exclusion. A soft preference tolerates a wrong
answer. An allergen does not.

Every rule below follows from that sentence. If a change would weaken it, the change
is wrong, however convenient. If you think the invariant itself is wrong, say so and
stop — do not route around it.

**Three gates enforce it. Do not remove or bypass any of them.**

| Gate | Where | What it does |
|---|---|---|
| 1 — Resolution | Constraint extraction | An exclusion that cannot be mapped to a canonical ingredient is asked about, never silently dropped |
| 2 — Query | SQL | Exclusion becomes `NOT EXISTS` over `recipe_ingredient` joined through the canonical ingredient tree |
| 3 — Output | Pre-render | Generated prose is scanned for aliases of excluded ingredients; a hit is rejected, logged, retried once, then downgraded to cards-without-prose |

Gate 2 guarantees the rows. Gate 3 exists because sentences invent. Both are load-bearing.

---

## 2. Architecture rules

These are decisions already made. Implement against them; don't relitigate them mid-task.

- **The model parses intent and writes prose. It never decides what exists.**
  Constraint extraction returns a typed object. SQL produces the candidate set. Only
  then does a model rank and explain, and only over rows it was handed. Any recipe ID
  in model output that wasn't in the input is dropped before render.
- **Allergens hang off the canonical ingredient, not the recipe.** A recipe is
  dairy-free because none of its resolved ingredients carry the `dairy` tag — derived,
  never asserted. There is no recipe-level allergen column. Do not add one.
- **`raw_text` is never discarded.** Extraction writes both the canonical id and the
  original string, so a reviewer can see what the model was looking at.
- **Unresolved ingredients are a first-class state, not `null`-and-move-on.** A
  `recipe_ingredient` with `canonical_id = null` blocks its recipe from leaving draft.
  An unknown ingredient is exactly where an allergen hides.
- **Extraction never writes a published recipe.** Intake writes a draft plus per-field
  confidence. A human promotes it from `/review`. No confidence threshold auto-publishes.
- **Every model call has a Zod schema on its output**, and the schema is the same one
  the HTTP boundary uses. Parse, don't cast.
- **Prompts live in `lib/ai/prompts/`** as named exports with their schema beside them
  and a `VERSION` constant. Never inline a prompt in a route handler.

### Deliberately absent — do not add

No repository/service abstraction (route handlers query Drizzle directly — the
boundary gets introduced when a second consumer appears, not before). No streaming
(it conflicts with validating output before display). No LangChain or model-client
wrapper. No component library. No caching layer. No queue. No auth, multi-user, meal
planning, shopping lists, or nutrition data.

If a task seems to need one of these, stop and raise it rather than adding it.

---

## 3. Repo map

```
app/                  Next.js App Router — three screens, four routes
  page.tsx            Cook      — free text in, ranked shortlist out
  intake/             Intake    — paste or photo in, structured draft out
  review/             Review    — the queue, the publish gate, the alias fix
  api/                Route handlers (the API layer)
lib/
  ai/
    client.ts         Anthropic SDK, direct, unwrapped
    prompts/          One file per call; prompt + schema + VERSION together
  db/
    schema.ts         Drizzle schema — canonical_ingredient is the spine
    client.ts         Connection
  domain/             Pure functions: constraint types, exclusion logic, validation
scripts/seed/         One-off generation script + committed JSON catalogue
scripts/workflow/     verify.sh (definition of done) + hook tests
.claude/              Workflow skills, invariant-reviewer agent, guard hooks
.github/              Issue and PR templates
evals/                Fixtures, runner, and latest.md (the last committed run)
docs/decisions/       ADRs — one file per decision worth defending
```

---

## 4. The agentic workflow

This repository is built with AI agents doing most of the typing. The workflow is
part of the submission, not an implementation detail — keep it visible and keep it honest.

### 4.1 Spec before code

Every unit of work starts as a **GitHub issue** with:

1. What changes, in one sentence.
2. Acceptance criteria as a checklist — observable, not "works correctly".
3. Which gate or invariant it touches, if any.

No issue, no branch. If you are asked to do something that has no issue, create the
issue first and link it. The issue trail is the reviewer-visible evidence of how this
was built, so it is written for a reader, not for a queue.

### 4.2 The loop

```
issue → failing test or eval fixture → implement → verify → PR → merge
```

The loop is tooled — use it rather than doing the steps by hand. Design and trade-offs
in [ADR 0003](docs/decisions/0003-issue-driven-agentic-workflow.md).

| Step | Skill | Label after | Human |
|---|---|---|---|
| Specify | `/spec` — grill one question at a time, draft, file on approval | `status:spec` | approves the draft |
| Plan | `/plan <n>` — plan as an issue comment, then stop | — | moves label to `status:planned` |
| Build | `/build <n>` — refuses without `status:planned`; worktree; failing test first | `status:building` | |
| Verify | `/verify` — `scripts/workflow/verify.sh`, then the `invariant-reviewer` agent | | decides on CONCERNS |
| Ship | `/ship` — refuses unless this commit verified; PR with evidence | `status:in-review` | merges |

- **Never add `status:planned` yourself.** It is the human's plan approval.
- **Gate labels** — `gate:resolution`, `gate:query`, `gate:output` — are set at `/spec`.
  A gate-labelled issue doesn't pass `/verify` without a changed test or fixture and a
  regenerated `evals/latest.md`.
- **Hooks** (`.claude/hooks/`, need `jq`) deny commits and pushes on `main`, writes to
  `evals/thresholds.ts`, and commit subjects over 72 chars or without `(#n)`; they put
  dependency changes to the human. A hook block is a rule, not an obstacle — don't route
  around it.

- **Write the failing thing first.** For domain logic that's a Vitest case. For model
  behaviour that's an eval fixture. A change to exclusion behaviour with no fixture
  covering it does not get merged.
- **Implement the smallest change that passes.** Resist adjacent refactors; open a new
  issue instead.
- **Verify before claiming done** — see 4.4. "It should work" is not verification.

### 4.3 Branches and commits

- Branch: `<issue-number>-<kebab-summary>` (e.g. `14-gate-3-output-validation`).
- One concern per branch. Parallel agent work happens in separate git worktrees so two
  agents never share a working tree.
- Commit subject: imperative, ≤ 72 chars, referencing the issue — `Add gate 3 output
  validator (#14)`.
- Commit body answers **why**, not what. The diff already says what.
- Never commit `.env`, API keys, or `node_modules`. Never commit a passing eval report
  that wasn't actually run.

### 4.4 Definition of done

A task is done when **all** of these are true:

- [ ] `pnpm typecheck` passes with no `any` introduced and no `@ts-expect-error` added
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] If the change touches extraction, ranking, or any gate: `pnpm eval` passes its
      thresholds, and `evals/latest.md` is regenerated and committed
- [ ] The issue's acceptance checklist is ticked, with evidence (output, screenshot, test name)
- [ ] The README still describes what the code actually does

### 4.5 When to stop and ask

Stop and ask rather than deciding alone when:

- A change would weaken the invariant or remove a gate.
- A test or eval threshold is failing and the tempting fix is to lower the threshold.
  **The exclusion threshold is 100% and is not negotiable** — a failing exclusion
  fixture means a better prompt or a narrower schema, never a lowered bar.
- The task implies one of the "deliberately absent" items in §2.
- A dependency needs adding. Every dependency is a decision someone has to defend in
  the review.
- Real spend is involved (model credits beyond the eval suite, a paid tier).

### 4.6 Working with the model

- Cheap/fast model for constraint extraction: short input, small schema, called often.
- Larger model for recipe extraction: long messy input, expensive mistakes, vision for
  the handwritten-card path.
- Bump a prompt's `VERSION` whenever its text changes, and re-run the eval suite. An
  eval report is meaningless if you can't tell which prompt produced it.
- `pnpm eval` calls the real API and costs real money. Don't run it in a loop; don't
  wire it into every push.

---

## 5. Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server |
| `pnpm build` | Production build |
| `pnpm typecheck` | `next typegen` then `tsc --noEmit`, strict |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest unit tests (no network, no API calls) |
| `pnpm eval` | Eval suite against the real model — costs money, non-deterministic |
| `pnpm db:push` | Apply the Drizzle schema to the local database |
| `pnpm seed` | Load the committed catalogue JSON |
| `docker compose up -d` | Local Postgres |

A clean clone must reach a working app via: `pnpm i` → `docker compose up -d` →
`pnpm db:push` → `pnpm seed` → `pnpm dev`. If a change breaks that path, the change
isn't done. Test it from an actual clean clone before submission.

---

## 6. Code style

- TypeScript strict. No `any`. No non-null assertions on model output — parse it.
- Zod at every boundary: HTTP request, HTTP response, model output, seed JSON.
- Server Components by default; `"use client"` only where interaction demands it.
- Domain logic in `lib/domain/` as pure functions, unit-tested without a database.
- Errors are values at boundaries. Don't swallow a gate failure into a generic 500 —
  a rejected output is a logged, counted event.
- No comments restating the code. Comment only the non-obvious *why*.

---

## 7. Context for the reviewer

Mise is a technical-challenge submission for a Senior Full-Stack Engineer role. It is
scoped to roughly eight hours of work. Where something is missing, it is missing on
purpose and the README says why. The full build plan — scope, trade-offs, the cut-line
— lives in `docs/decisions/`.

@AGENTS.md
