# Evals

`pnpm eval` runs fixtures against the real model, prints a table, and exits non-zero
below threshold. It costs money and it is non-deterministic, so it runs on demand —
not on every push, and never in CI (ADR 0003). That distinction is deliberate.

Two suites are built. Output safety is planned.

| Suite | Status | Fixtures | Measures | Threshold |
|---|---|---|---|---|
| Constraint extraction | built | 17 queries × 3 runs | Exact match on `exclude`; micro-F1 on `have` / `avoid`; exact on `maxMinutes` | **1** on `exclude_exact`, 0.8 elsewhere |
| Recipe extraction | built | 6 sources × 3 runs | Per-field accuracy over what a source states; null-precision over what it doesn't | 0.85 on `field_accuracy`, **1** on `null_precision` |
| Output safety | planned | 10 adversarial | Share of fixtures with no violation reaching render | **1** (a rate, since thresholds are minimums: zero violations) |

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

## Constraint extraction (`suites/constraint-extraction.ts`)

Runs call 1 (`lib/ai/prompts/extract-constraints.ts`) on each query in
`fixtures/constraint-extraction/`. A fixture is:

```json
{
  "gates": ["resolution"],
  "query": "No nuts and no eggs, 40 minutes max",
  "expected": { "exclude": ["nuts", ["egg", "eggs"]], "avoid": [], "have": [], "maxMinutes": 40 }
}
```

- **Spelling variants.** An expected term is a string, or a list of spellings of *one*
  ingredient (singular/plural). It is never a list of different ingredients.
  `fixtures.test.ts` checks that no spelling sits under two terms, and that every
  spelling of every expected `exclude` term resolves against the seed taxonomy and
  leaves. A passing eval therefore means call 1 handed gate 1 terms it can resolve.
- **Three runs per fixture** (51 calls). The model is non-deterministic, and one sample
  at a 100% bar is weak evidence.
- **Metrics.**
  - `exclude_exact`: share of runs whose `exclude` set matches exactly, compared with
    `normaliseTerm` as gate 1 does.
  - `max_minutes_exact`: share of runs with the exact value.
  - `have_f1` and `avoid_f1`: micro-F1, with counts summed over every run.
- **A failed call** (`refused`, `parse_failed`, `api_error`) scores as a miss on
  `exclude` and `maxMinutes` even when nothing was expected, and all its expected terms
  count as false negatives. A failure is never a correct "no exclusions".
- **Mismatch log.** Each run that misses on any metric prints its query, what was
  expected and what came back to stderr. The report holds only numbers.
- **Prompt examples never reuse fixture wording**, so the suite measures whether the
  rules generalise.

## Recipe extraction (`suites/recipe-extraction.ts`)

Runs call 2 (`lib/ai/prompts/extract-recipe.ts`) on each source in
`fixtures/recipe-extraction/`, three runs each, on `MODELS.capable` — the first thing
here measuring that tier. A fixture is:

```json
{
  "gates": ["resolution"],
  "source": "Anchovy butter cabbage — serves 2\n\ncabbage\nanchovies\n\nQuarter the cabbage…",
  "expected": {
    "title": "Anchovy butter cabbage",
    "serves": 2,
    "minutes": null,
    "ingredients": [{ "name": "cabbage", "qty": null, "unit": null }]
  }
}
```

**`null` means the source never states it.** One field carries both facts, because a
stated value is never null: `"minutes": null` is a claim about the source, and it is what
the model is measured against not inventing.

- **Metrics.**
  - `field_accuracy`: over what the source states — the title (compared with
    `normaliseTerm`), the scalars it gives, each expected line's presence, and the
    quantity and unit of the lines that were found. A dropped line is one miss, not
    three: the fields under it were never compared. That makes omission cheaper here than
    it is in consequence — see the README on what the 0.85 doesn't cover.
  - `null_precision`: over what the source doesn't — the scalars it omits, the quantity
    and unit of the bare lines it lists, and every returned line matching nothing in the
    source. A `null` scores; any value at all does not.
- **Ingredient lines are paired by name**, exactly as `normaliseTerm` compares them, each
  actual line filling at most one expected slot. Expected names take spelling variants,
  the same convention call 1's fixtures use.
- **A failed call** (`empty_input`, `refused`, `parse_failed`, `api_error`) misses every
  unit either metric would have weighed. Null because nothing came back is not null
  because the model read the text and found nothing there.
- **Nothing weighed is not a pass.** A run set that left no field unstated scores 0 on
  `null_precision`, not a vacuous 1 — the same reason the harness refuses a suite with no
  fixtures.
- **Not scored:** `optional`, `rawText` fidelity, `confidence` and the steps. Ingredients
  and scalars are where an invented value costs something; `rawText` is covered by unit
  tests, and a confidently-scored invention is worth its own suite.
- **Every source has a title and a method.** `draftRecipeSchema` needs an ingredient and a
  step, so an ingredients-only source returns `parse_failed` and scores zero for reasons
  that aren't about invention. And the prompt answers a titleless source with "the
  shortest plain description of the dish", which no fixture could match exactly.
- **Stated conversions are accuracy, not invention.** The prompt fixes `"½"` as `0.5` and
  a range at its lower bound (`"2-3"` is `2`), so those are values the source states.
  `05-ranges-and-vague-amounts.json` holds both sides of that line in one source.
- **Mismatch log**, as call 1's suite has: any run that misses prints its title, what was
  expected and what came back, to stderr.

## Why `exclude` is pegged at 100%

Because thresholds should be set by consequence, not by what the model currently
achieves. When a fixture fails, the fix is a better prompt or a narrower schema — not a
lowered bar.

## Null-precision

Everyone measures extraction accuracy. Almost nobody measures whether the model
invented a plausible value for a field that wasn't in the source. A model that guesses
`serves: 4` is more dangerous than one that returns `null`, because `null` is visible in
the review queue and a wrong `4` is not. Tracked and reported separately, and pegged at
1 for the same reason `exclude_exact` is: a reviewer fills in a blank and approves a
plausible number, so the cost of an invention is a wrong recipe nobody caught. The two
metrics are separate because they fail for different reasons, and only one of them is
negotiable.

## Fixtures are hand-written

Fifteen good fixtures beat a hundred generated ones, and generating fixtures with the
same model under test is circular. Six sources that fail for distinct reasons beat twelve
that fail together, which is why the recipe suite has six. The constraint suite needs the
cases that actually break:

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
the tables.
