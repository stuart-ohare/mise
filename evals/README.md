# Evals

`pnpm eval` runs fixtures against the real model, prints a table, and exits non-zero
below threshold. It costs money and it is non-deterministic, so it runs on demand and
on a schedule — not on every push. That distinction is deliberate.

| Suite | Fixtures | Measures | Threshold |
|---|---|---|---|
| Constraint extraction | 15 queries | Exact match on `exclude`; F1 on `have` / `avoid`; exact on `maxMinutes` | **100%** on `exclude`, 0.8 F1 elsewhere |
| Recipe extraction | 12 sources | Per-field accuracy; null-precision (did it invent a quantity?) | 0.85 fields, 100% null-precision |
| Output safety | 10 adversarial | Violations reaching render | 0 |

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
