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
| Model client | Anthropic SDK, direct | No LangChain, no wrapper — see [ADR 0004](docs/decisions/0004-model-provider.md) |
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
pnpm seed                      # load the allergen tree and 60 recipes (3 left in draft)
pnpm dev
```

| Command | What it does |
|---|---|
| `pnpm typecheck` | `next typegen` then `tsc --noEmit` |
| `pnpm test` | Vitest units — no network, no API calls, no database |
| `pnpm test:db` | Gate 2's SQL and the seed's term-collision and tree-change checks against Postgres (`*.db.test.ts`). Needs `docker compose up -d`, `pnpm db:push` and `DATABASE_URL` in `.env.local`. Every write rolls back, and it doesn't need the seed. Not run in CI |
| `pnpm eval` | Eval suite against the real model. **Costs money** — one run is 51 calls — and is non-deterministic. Runs the constraint-extraction suite: 17 fixtures, 3 runs each ([evals/README.md](evals/README.md)) |

## Deploying

Vercel, with Postgres from Neon. Production and Preview share one Neon database: a
branch per preview is deliberately not set up yet, so a schema push from any branch
changes what production reads.

**1. Provision.** In the Vercel project, **Storage → Create Database → Neon**, Free plan,
connected to Production and Preview. Leave **Custom Prefix** empty — the app reads plain
`DATABASE_URL`. If Vercel reports that `DATABASE_URL` already exists, look at what it
points to before removing it.

**2. Env vars.** The integration injects `DATABASE_URL` (pooled) plus
`DATABASE_URL_UNPOOLED` and the `PG*`/`POSTGRES_*` set. The app only reads
`DATABASE_URL`; `ANTHROPIC_API_KEY` is added by hand. Check with:

```bash
vercel link                    # once per checkout
vercel env ls                  # DATABASE_URL should list Production and Preview
```

The Neon values are marked sensitive, so `vercel env pull` writes them as empty strings.
Copy the pooled connection string from **Storage → your database → `.env.local` → Show
secret** (or the Neon console) instead.

**3. Schema.** From a local shell, not CI — CI holds no database secret:

```bash
DATABASE_URL='<neon pooled url>' pnpm db:push
```

The variable on the command line wins over `.env.local` (dotenv doesn't overwrite a set
variable), so this can't hit the local database by accident — but check the host in the
printed statements anyway. `drizzle.config.ts` is `strict`, so drizzle-kit shows the SQL and
asks for confirmation; that prompt needs a real terminal and won't run from a pipe or an
agent's shell. The push works through Neon's pooler; if it ever doesn't, use
`DATABASE_URL_UNPOOLED`.

**4. Seed production.** Same shape. It loads the allergen tree and the recipe catalogue, is
safe to rerun, and prints the host it wrote to — check it isn't `localhost`:

```bash
DATABASE_URL='<neon pooled url>' pnpm seed
```

If a change to the tree since the last seed would move an existing ingredient's parent or
tags, it writes nothing and lists each one. Once every line is intended, run it again with
`--apply-tree-changes` ([scripts/seed/README.md](scripts/seed/README.md)).

**5. Deploy.** Pushing to `main` deploys production. Env vars only reach a build made
after they were set — after changing one, redeploy (`vercel redeploy <deployment-url>
--target production`).

## Working on this repo

[`CLAUDE.md`](CLAUDE.md) holds the working agreements: the invariant, the architecture
rules that are settled, the definition of done, and the agentic workflow this was built
with. Read it before the first change.

Every change goes through the same loop, run as Claude Code skills against GitHub
issues:

```
/spec → /plan → /build → /verify → /ship → human merge → status:done (automatic)
```

The issue is the spec. The plan is an issue comment the human approves with `/approve`,
a skill only the user can start. The build happens in its own worktree with the failing
test written first. `/verify` runs the definition of done plus an independent
`invariant-reviewer` agent, and the PR ticks each acceptance criterion against evidence.
Git hooks (installed by `pnpm i`) stop commits and pushes on `main` and enforce the
commit format. Claude Code hooks stop agents skipping those git hooks, editing the eval
thresholds, or changing dependencies or approving plans without the human; they need
[`jq`](https://jqlang.org). Why it's built this way is in
[ADR 0003](docs/decisions/0003-issue-driven-agentic-workflow.md).

### CI

GitHub Actions runs two workflows. Neither needs a secret or calls a model:

- `checks` (typecheck, lint, test) runs on every PR and push to `main`.
- `issue-done` runs when a PR merges. It moves every issue the PR closes (`Closes #n`)
  to `status:done`.

`pnpm eval` never runs in CI, because it costs money and isn't deterministic.

`main` is protected: changes arrive by PR, `checks` must pass, force-pushes are
blocked, the branch can't be deleted, and the rules apply to admins too.

Claude doesn't run on GitHub. The `invariant-reviewer` runs locally in `/verify`, and
its report goes in the PR body.

## Trade-offs

Six decisions that shaped what is here, each with what it cost and what would change it.
The ones worth defending at length are recorded in [`docs/decisions/`](docs/decisions).

### No streaming

Gate 3 scans generated prose for every alias of every excluded ingredient before any of
it renders, and on a second failure `runOutputGate` returns a `downgraded` result that
carries no generated text at all. A token already on screen cannot be unsent, so
validation and streaming want the same moment and only one of them can have it
([ADR 0002](docs/decisions/0002-exclusion-is-a-database-constraint.md)).

**Cost.** Cook will feel slower than a streaming chat: nothing can appear until the whole
response has been scanned, and a retry doubles that wait.

**Revisit when.** The filtered cards can render while only the prose waits on the gate.
Gate 2 has already proved those rows safe — that is a partial result rather than a
streamed one, and it is the version of this idea worth building.

### Two models, not one

Constraint extraction runs on `claude-haiku-4-5`. Recipe extraction and ranking are
reserved for `claude-sonnet-4-5`, which so far only the one-off catalogue generator
calls. Short frequent input with a small schema and long messy input where a mistake is
expensive are different jobs, and `lib/ai/client.ts` names the two tiers separately
([ADR 0004](docs/decisions/0004-model-provider.md)).

**Cost.** Two sets of model quirks to learn and two eval baselines to keep honest — and
only one of those exists. The 17 committed fixtures all run against the fast model;
nothing yet measures `MODELS.capable`, which is the tier doing the expensive work.

**Revisit when.** One model clears both bars on the same fixtures at the cheaper price.
That is a measurement rather than a guess, so the suite that would make it has to exist
first.

### `exclude` is pegged at 100%

`evals/thresholds.ts` sets `exclude_exact: 1`. Not 0.98 — a threshold set by what the
model currently achieves is a threshold that moves when the model has a bad day.

**Cost.** One failing fixture blocks a merge, and the only permitted fixes are a better
prompt or a narrower schema (CLAUDE.md §4.5). That is real time spent on a red build
that a lower number would have turned green.

**Revisit when.** Never for the bar itself. What moves is the fixture set — 17 today, and
every new way someone phrases an exclusion belongs in it. A failure is answered by making
the extraction better, never by making the test weaker.

### Hand-authored tree, generated leaves

The 53 nodes of the allergen hierarchy are written by hand; the 125 leaves and 60 recipes
were generated once and committed as JSON. Only 11 of those leaves hang under a
hand-authored node — `parmesan` under `cheese`, `linguine` under `pasta` — and the other
114 stand outside the tree, where no allergen is at stake. A generated leaf can never
carry a tag of its own, so every allergen in the catalogue traces to a node a human
placed ([`scripts/seed/README.md`](scripts/seed/README.md)).

**Cost.** The tree does not grow at the speed of the catalogue. Every new allergen,
cuisine or awkward ingredient needs a human to decide where it hangs, and until someone
does, an unresolved ingredient blocks its recipe from leaving draft.

**Revisit when.** A leaf's placement can be verified as cheaply as it can be generated —
an eval over resolution, rather than a person reading a diff of the tree.

### No caching, no queue, no model wrapper

Nothing is memoised and nothing is queued, so each Cook request will call constraint
extraction again. The Anthropic SDK is imported directly in one file rather than behind a
provider-agnostic client (Tech stack, above, and ADR 0004).

**Cost.** Repeated work at repeated cost, and no protection against a slow or failing
provider — an outage will break Cook rather than degrade it. Swapping provider means
editing `lib/ai/client.ts` and each call site: roughly a day, growing with each new call.

**Revisit when.** A second consumer appears, an identical query is repeated often enough
to measure, or an eval run on the same fixtures says another provider is better.

### No model in CI

`checks` runs typecheck, lint and test on every PR and holds no Anthropic secret. The
`invariant-reviewer` runs locally inside `/verify`, and `pnpm eval` is run by hand —
`verify.sh` only checks that a gate-labelled change committed a fresh `evals/latest.md`
([ADR 0003](docs/decisions/0003-issue-driven-agentic-workflow.md)).

**Cost.** The model-checked half of the definition of done is only as reliable as the
person who ran it. A PR can be green with a stale `evals/latest.md`, and the reviewer's
report is pasted evidence rather than something CI reproduced.

**Revisit when.** `pnpm eval` is deterministic or cheap enough to run per PR, or there is
a budget worth defending for it. Until then the honest version is a local run with its
report committed.
