# Mise

**An exclusion is never a model decision. It is a database constraint, and generated
text is validated against it before it renders.**

Mise answers one question — *what can I actually cook right now* — against a recipe
catalogue it also knows how to build. It is aimed at a home cook feeding a household
where one person has a hard dietary exclusion. That detail is the whole product: a soft
preference tolerates a wrong answer, an allergen does not, and every architectural
decision here follows from treating exclusion as a safety property rather than a
ranking signal.

*Mise en place* is the kitchen discipline of prepping every ingredient before any
cooking starts. It names the architecture rather than the app. The canonical ingredient
tree, the alias table, the allergen hierarchy — all of it is prep work done before a
single query arrives. At request time the system looks things up and explains them. It
does not ask a model to be careful at the moment carefulness is hardest to verify.

> **Status: scaffold.** The structure, domain model and working agreements are in
> place; the three screens are not built yet. Progress is tracked in
> [Issues](../../issues).

## Two surfaces

**Cook.** Free text in — *"half a cauliflower, no dairy, 25 minutes, and I can't face
another curry"* — and a ranked shortlist out, with substitutions explained. What the
system understood renders as chips above the results, so a misread can be corrected
without retyping the sentence. Hard exclusions look different from soft preferences,
because the interface should tell the same story as the architecture.

**Intake.** Paste a recipe blog's wall of text or a photo of a handwritten card. Out
comes a structured recipe with per-field confidence, landing in a review queue — never
straight into the database.

## The three gates

| Gate | Where | What it does |
|---|---|---|
| 1 — Resolution | Constraint extraction | An exclusion that can't be mapped to a canonical ingredient is asked about, never silently dropped |
| 2 — Query | SQL | The exclusion becomes a `NOT EXISTS` over `recipe_ingredient` joined through the canonical tree. Recipes containing ghee vanish from a dairy-free search because ghee's parent is dairy — not because anyone tagged the recipe |
| 3 — Output | Pre-render | Generated prose is scanned for aliases of anything excluded. A hit is rejected, logged and retried once; a second failure returns cards without prose rather than unverified text |

Gate 2 already guarantees the rows. Gate 3 exists because the model writes sentences,
and sentences invent — *"finish with a knob of butter"* attached to a recipe that
contains none. The filter guarantees the rows; nothing guarantees the sentences except
checking them.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js App Router, single app | One deploy, one type boundary. A separate API server is right at scale and wrong at this scope |
| Language | TypeScript, strict, no `any` | |
| Validation | Zod, shared client and server | The same schema validates model output and the HTTP boundary. This is the load-bearing choice |
| Database | Postgres (Docker Compose), Drizzle | Real SQL, real constraints, real migrations |
| Model client | Anthropic SDK, direct | No LangChain, no wrapper |
| UI | Tailwind, hand-rolled components | Three screens don't earn a component library |
| Tests | Vitest for units, plus an eval suite | Aiming at the invariants, not at coverage |

## How AI is used

Three model calls, each with a narrow job and a Zod schema on its output. All prompts
live in [`lib/ai/prompts/`](lib/ai/prompts) with their schema and a version constant.

1. **Constraint extraction** — free text to typed constraints. The `exclude` / `avoid`
   split is the most important line in the codebase: one is a `WHERE` clause, the other
   is a ranking weight.
2. **Recipe extraction** — messy text or an image to a draft with per-field confidence.
   Its central instruction is that an unstated quantity returns `null`; a plausible
   invented quantity is worse than a missing one, because a reviewer skims past it.
3. **Ranking and explanation** — takes the already-filtered candidate rows and returns
   an ordered list of IDs with a rationale each, constrained to the IDs it was given.

The model parses intent and writes prose. It never decides what exists.

## Running it

Needs Node, pnpm, Docker, and [`jq`](https://jqlang.org) for the workflow guards.

```bash
pnpm install                   # also installs the git hooks (skipped by --ignore-scripts)
cp .env.example .env.local     # add your ANTHROPIC_API_KEY
docker compose up -d           # Postgres on :5432 (POSTGRES_PORT to change it)
pnpm db:push                   # apply the Drizzle schema
pnpm seed                      # load the committed catalogue — not built yet
pnpm dev
```

| Command | What it does |
|---|---|
| `pnpm typecheck` | `next typegen` then `tsc --noEmit` |
| `pnpm test` | Vitest units — no network, no API calls |
| `pnpm eval` | Eval suite against the real model. Costs money, non-deterministic — not built yet |

## Working on this repo

[`CLAUDE.md`](CLAUDE.md) holds the working agreements: the invariant, the architecture
rules that are settled, the definition of done, and the agentic workflow this was built
with. Read it before the first change.

Every change goes through the same loop, run as Claude Code skills against GitHub
issues:

```
/spec → /plan → /build → /verify → /ship → human merge
```

The issue is the spec. The plan is an issue comment the human approves by moving a
label. The build happens in its own worktree with the failing test written first.
`/verify` runs the definition of done plus an independent `invariant-reviewer` agent,
and the PR ticks each acceptance criterion against evidence. Git hooks (installed by
`pnpm i`) stop commits and pushes on `main` and enforce the commit format. Claude Code
hooks stop agents skipping those git hooks, editing the eval thresholds, or changing
dependencies without approval; they need [`jq`](https://jqlang.org). Why it's built this way is in
[ADR 0003](docs/decisions/0003-issue-driven-agentic-workflow.md).

### CI

| Workflow | Runs on | Costs | Merge-blocking |
|---|---|---|---|
| `checks` | Every PR and push to `main` | Nothing (typecheck, lint, test) | **Yes**, required on `main` |
| `claude-review` | PR opened ready, or a draft marked ready. **Not** on later pushes | One Opus run, capped at 30 turns | No. It posts the `invariant-reviewer` report as one advisory comment |
| `claude` | `@claude` in an issue or PR comment, from users with write access | One run, capped at 15 turns | No. Read and comment only; building happens through the local loop |

`main` is protected: changes arrive by PR, `checks` must pass, force-pushes are blocked,
and the rules apply to admins too. `pnpm eval` is never run in CI (it costs money and
isn't deterministic).

One-time setup for the Claude workflows. Forks and clones without it still get `checks`:

1. Add an `ANTHROPIC_API_KEY` repository secret (Settings → Secrets and variables → Actions).
2. Install the Claude GitHub App on the repository: run `/install-github-app` in Claude
   Code, or go to <https://github.com/apps/claude>.

## Trade-offs

To be written as the decisions land. Individual decisions worth defending are recorded
in [`docs/decisions/`](docs/decisions).
