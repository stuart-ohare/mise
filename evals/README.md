# Evals

`pnpm eval` runs fixtures against the real model, prints a table, and exits non-zero
below threshold. It costs money and it is non-deterministic, so it runs on demand —
not on every push, and never in CI (ADR 0003). That distinction is deliberate.

**Today the harness exists and no suite does.** `pnpm eval` exits non-zero with
`no suites registered` and writes no report. The suites below are planned; the first
arrives in #32.

| Suite (planned) | Fixtures | Measures | Threshold |
|---|---|---|---|
| Constraint extraction | 15 queries | Exact match on `exclude`; F1 on `have` / `avoid`; exact on `maxMinutes` | **100%** on `exclude`, 0.8 F1 elsewhere |
| Recipe extraction | 12 sources | Per-field accuracy; null-precision (did it invent a quantity?) | 0.85 fields, 100% null-precision |
| Output safety | 10 adversarial | Share of fixtures with no violation reaching render | **1** (a rate, since thresholds are minimums: zero violations) |

## How the harness works

| File | Role |
|---|---|
| `run.ts` | `pnpm eval`. Loads `.env.local`, runs the registry, writes `latest.md`, sets the exit code |
| `harness.ts` | The rules below. Never calls a model — suites do — so it is tested offline (`harness.test.ts`) |
| `suites.ts` | The registry: every suite `pnpm eval` runs |
| `thresholds.ts` | `suite → metric → minimum`. **Human-written**: the guard hooks deny agent writes (CLAUDE.md §4.5) |
| `fixtures/<suite>/*.json` | One directory per suite, named after it |

A suite is registered with `defineSuite({ name, prompt: { name, version }, model,
fixtureSchema, run })`. `run` receives the parsed fixtures and returns
`Record<metric, number>`. `prompt.version` is the prompt's `VERSION` constant, so every
report is tied to the text that produced it.

A run fails, with a non-zero exit code, when:

- **No suite is registered.** No report is written — an empty run can never produce one.
- **The setup is wrong.** A fixture is invalid (not JSON, no non-empty `gates` array of
  known gate names, or failing the suite's own `fixtureSchema`). Or a suite has no
  fixtures, two suites share a name, a suite has no thresholds (or an empty entry), or
  `thresholds.ts` has an entry for a suite that isn't registered. All of this is checked
  before any suite runs, so nothing is spent on a run that can't finish, and no report
  is written.
- **A suite throws.** The run aborts with no report; a partial run isn't a record.
- **A metric is below its threshold.** A metric passes when `value >= threshold`, so
  "zero violations" is expressed as a rate of 1. The report **is** written, marked
  `fail`: a failing run is still an honest record.
- **A metric and its threshold don't pair up.** A reported metric with no threshold, or
  a threshold with no reported metric, fails. No metric goes unchecked.

## Why `exclude` is pegged at 100%

Because thresholds should be set by consequence, not by what the model currently
achieves. When a fixture fails, the fix is a better prompt or a narrower schema — not a
lowered bar.

## Null-precision

Everyone measures extraction accuracy. Almost nobody measures whether the model
invented a plausible value for a field that wasn't in the source. A model that guesses
`serves: 4` is more dangerous than one that returns `null`, because `null` is visible in
the review queue and a wrong `4` is not. Tracked and reported separately.

## Fixtures are hand-written

Fifteen good fixtures beat a hundred generated ones, and generating fixtures with the
same model under test is circular. The constraint suite needs the cases that actually
break:

- *"no dairy but butter is fine"* — an explicit carve-out inside an exclusion
- *"nothing too heavy"* — unmappable; must not become a false hard constraint
- *"I'm cooking for Sam, they can't do gluten"* — exclusion attributed to a third party;
  a naive prompt puts the person's name in `have`
- *"under half an hour"* — natural-language duration
- *"had pasta twice this week"* — soft avoidance stated as history, not preference

The first adversarial safety fixture is a recipe with an innocent title whose method
mentions butter only in an optional finishing step, queried with a dairy exclusion and a
request for something rich. That is the case that breaks naive implementations.

## Gate tags

Each fixture declares which gate it exercises, in a top-level `gates` array:

```json
{ "gates": ["output"], "query": "no dairy, something rich", "…": "…" }
```

Vitest cases do the same with a comment line: `// @gate query`, or `// @gate query output`
for several gates. The line holds gate names only; put any explanation on the line above.
The names are `resolution`, `query` and `output`, matching the `gate:*` issue labels.

- For a gate-labelled issue, `/verify` requires at least one added or modified test or
  fixture tagged for each of its gates. A test that exists but covers a different gate
  doesn't count.
- An unknown name fails `/verify` on any issue, so a typo is caught in the PR that
  introduces it.

A tag is a claim, not proof of coverage. Renaming an old tagged test also satisfies the
rule. Whether the tagged test actually exercises the change is what the
`invariant-reviewer` checks.

## `latest.md`

The last run's output is committed here so a reviewer who doesn't want to spend their
own API credits can still see that the suite exists and what it found.

It has a header naming the run time, the commit, and each suite's prompt name,
`VERSION` and model; one table per suite (metric, value, threshold, pass/fail); and a
closing fenced `json` block with the same data, rendered from the same object. Anything
that checks the report parses that block with `reportSchema` in `harness.ts`, never
the tables. No `latest.md` is committed yet: none can be produced honestly until a
suite exists (#32).
