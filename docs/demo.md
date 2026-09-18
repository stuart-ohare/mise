# Demo walkthrough

From a fresh clone to every outcome Mise can produce, in the order that makes the
argument. Each step says what to run, what should happen, and what did happen on the
recorded run. A step whose **Observed** no longer matches its **Expected** is a failure,
not stale prose — open an issue for it.

**Recorded run:** 2026-09-18, commit `d915f39`. It ran from a git worktree, not a
directory called `mise`, so the reset was `docker compose -p mise down -v` and
`pnpm db:push`'s confirmation was answered through a pseudo-terminal. Step 1 explains
both. From the seed onwards, every step ran once, in order, against that fresh database.
The seed's `0 already present` line is the evidence it was fresh.
Model output is non-deterministic, so *Observed* records the shape of each answer — its
`kind`, counts, which recipes — rather than the wording.

Two audiences. A reviewer gets a tour that doesn't depend on the recording. The author
gets a pre-submission check that the clean-clone path still works.

Cook and Intake call the real API. The recorded pass made roughly 30 model calls, mostly
Haiku; Intake uses Sonnet. It does not run `pnpm eval`.

The API calls below use `curl` and [`jq`](https://jqlang.org), which the workflow guards
already need. Every one has a screen that does the same thing, and a request from the
screen and one from `curl` are the same request.

---

## 1. Clean start

```bash
pnpm install
cp .env.example .env.local        # add your ANTHROPIC_API_KEY
docker compose down -v            # drop any previous database, volume included
docker compose up -d --wait
pnpm db:push                      # asks for confirmation: choose "Yes, I want to execute all statements"
pnpm seed
docker compose exec postgres psql -U mise -d mise \
  -c "select status, count(*) from recipe group by 1 order by 1"
pnpm typecheck && pnpm lint && pnpm test
pnpm dev
```

The Postgres user and database are both `mise`, not `postgres`.

**Expected:** seed reports 60 recipes, 3 left in draft. The three checks pass.

**Observed:**

```
Seeded taxonomy into localhost:5432/mise: 178 ingredients, 26 aliases.
Recipes: 57 published, 3 draft, 0 already present.

  status   | count
-----------+-------
 draft     |     3
 published |    57
```

The drafts are *Spiced lentil dal with ghee*, *Crispy panko fish fillets* and *Brinjal and
tomato curry* — the three deliberately missing aliases ([`scripts/seed/README.md`](../scripts/seed/README.md)).
37 test files, 586 tests passed; typecheck and lint clean.

Two things tripped the recorded run. Neither breaks a fresh clone run from a terminal:

- **`pnpm db:push` prompts even on an empty database**, because `drizzle.config.ts`
  sets `strict: true`. In a terminal it's one keypress. Without a TTY it fails with
  *"Interactive prompts require a TTY terminal"*, and `pnpm seed` then fails with
  `Failed query: select "name", "name" from "canonical_ingredient"` because no table
  exists.
- **Compose names the project after the directory, but the container name is fixed**
  (`mise-postgres`). Run from a directory not called `mise` — a git worktree, a second
  clone — and `docker compose down -v` resets an empty project while `up` fails with
  *"The container name "/mise-postgres" is already in use"*. Pass `-p mise` to every
  `docker compose` command in that case.

## 2. Cook, the happy path

Open <http://localhost:3000> and ask:

> Half a cauliflower, no dairy, 25 minutes, and I can't face another curry

```bash
cook() { curl -s localhost:3000/api/cook -H 'content-type: application/json' \
  -d "$(jq -n --arg q "$1" '{kind:"query",query:$q}')"; }

cook "Half a cauliflower, no dairy, 25 minutes, and I can't face another curry" \
  | jq '{kind, constraints, results: [.results[] | {title: .recipe.title, minutes: .recipe.minutes, rationale}]}'
```

**Expected:** `ranked`. The hard exclusion's chip looks different from the soft ones.
Every result has a rationale.

**Observed:** `ranked`, first attempt. Constraints `exclude: [dairy]`, `avoid: [curry]`,
`have: [cauliflower]`, `maxMinutes: 25`. On screen the chips are **`✕ dairy`** with a
heavier border, then `not: curry`, `has: cauliflower`, `≤ 25 min` as plain chips, with
a line under them explaining that ✕ on a hard exclusion demotes it to a preference
rather than dropping it silently. Five results, each with a rationale, led by *Roasted
cauliflower steaks with tahini drizzle* (25 min) and *Spiced cauliflower rice with
chickpeas* (15 min).

## 3. Gate 1 asks

`ghee` is deliberately absent from the alias table.

> Something with lentils, no ghee

```bash
cook "Something with lentils, no ghee" | jq -c '{kind, unresolved, constraints}'
```

**Expected:** `needs_resolution` naming `ghee`, and no rows. The exclusion is neither
dropped nor guessed.

**Observed:**

```json
{"kind":"needs_resolution","unresolved":["ghee"],"constraints":{"exclude":["ghee"],"avoid":[],"have":["lentils"],"maxMinutes":null}}
```

No results, and no ranking call: the route returns before gate 2 runs.

## 4. The empty state

The fastest published recipe takes 10 minutes.

> Something I can make in 5 minutes, no dairy

```bash
cook "Something I can make in 5 minutes, no dairy" | jq -c '{kind, relaxTime, constraints}'
```

**Expected:** `no_candidates`, with `relaxTime` saying how many recipes a looser time
limit would find.

**Observed:**

```json
{"kind":"no_candidates","relaxTime":{"limit":5,"wouldMatch":39},"constraints":{"exclude":["dairy"],"avoid":[],"have":[],"maxMinutes":5}}
```

## 5. Gate 3

Gate 3 scans the generated rationales for any name or alias of an excluded ingredient.
A hit is logged to `output_violation`, retried once, and if the retry also hits, the
answer is `cards` with `reason: "output_violation"` — the rows without the prose.

The seed's adversarial case is *Tomato and chickpea stew*, whose only dairy is an
optional knob of butter. Ask for it dairy-free, then look at the table:

> Tomato and chickpea stew, no dairy

```bash
cook "Tomato and chickpea stew, no dairy" | jq -c '{kind, attempts, reason, titles: [.results[]? | (.recipe // .).title]}'
docker compose exec postgres psql -U mise -d mise \
  -c "select matched_term, retry_succeeded, query from output_violation order by created_at"
```

**Expected:** a row if the prose reached for an excluded term; otherwise, the stew
absent for a reason that has nothing to do with the model.

**Observed:** five runs, all `ranked` on the first attempt, **zero rows** in
`output_violation`. The stew was in none of the five shortlists. Without the exclusion,
*"Tomato and chickpea stew"* puts it first. Gate 2 is why: the optional butter still
counts, so the stew never reaches the model to be written about. Checked against the
dairy subtree with the query in step 7:

```
        title             | dairy_free
--------------------------+------------
 Tomato and chickpea stew | f
```

**An empty table is not reassurance.** It means the model behaved on these five runs,
not that gate 3 wasn't needed. The gate exists because sentences invent: a rationale for
a dairy-free recipe can still say "finish with a little butter". The rejection path is
exercised deterministically, without a model, by:

- `lib/domain/output-gate.test.ts` — the scan: every alias under an excluded node, word
  starts, multi-word and hyphenated terms, accents, and deliberately no negation parsing
- `app/api/cook/run.test.ts` — rejection, the one retry, and the downgrade to `cards`
  with `reason: "output_violation"`
- `app/api/cook/route.test.ts` — one `output_violation` row per matched term

To see a row in the running app, the prose has to name an excluded food, and the scan
doesn't parse negation, so a rationale saying "no butter needed" under a dairy exclusion
counts as a hit. Nothing in the recorded run's queries made the model write that, and
five runs is the budget this walkthrough gives it.

## 6. Intake

Open <http://localhost:3000/intake>.

### 6a. Pasted text

Paste this into the Intake screen, or save it as `paste.txt` for the `curl` below:

```text
Nduja spaghetti
Serves 2. Takes 20 minutes.

200g spaghetti
2 tbsp nduja
400g tin chopped tomatoes
2 cloves garlic, sliced
Olive oil
Salt

1. Cook the spaghetti in salted water.
2. Soften the garlic in olive oil, stir in the nduja until it melts, add the tomatoes and simmer 10 minutes.
3. Toss the drained pasta through the sauce.
```

```bash
curl -s localhost:3000/api/intake -H 'content-type: application/json' \
  -d "$(jq -n --rawfile r paste.txt '{sourceKind:"text",raw:$r}')" \
  | jq '{kind, recipe: .draft.recipe, unresolved: .draft.unresolved, fieldConfidence: .draft.fieldConfidence,
         lines: [.draft.ingredients[] | {rawText, name, canonicalName, qty, unit, confidence}]}'
```

**Expected:** a `draft` with a confidence for each field, `raw_text` beside every
resolution, at least one unresolved line, and a null quantity where the source gives
none.

**Observed:** `draft`, status `draft`, title / serves / minutes each at confidence 0.98.

| `rawText` | resolved to | qty | unit |
|---|---|---|---|
| 200g spaghetti | — | 200 | g |
| 2 tbsp nduja | — | 2 | tbsp |
| 400g tin chopped tomatoes | — | 400 | g |
| 2 cloves garlic, sliced | garlic | 2 | cloves |
| Olive oil | olive oil | null | null |
| Salt | salt | null | null |

Three unresolved, not one. `spaghetti` and `chopped tomatoes` are real ingredients the
tree knows as `pasta` and `tinned tomato`, but resolution is an exact lookup and never
guesses a near match. That is the design: `spaghetti` is exactly where gluten hides.

### 6b. A photograph

```bash
f=test-assets/recipe-cards/handwritten_recipe_apple_cake.png
printf '{"sourceKind":"image","raw":"data:image/png;base64,%s"}' "$(base64 -i "$f" | tr -d '\n')" > img.json
curl -s localhost:3000/api/intake -H 'content-type: application/json' --data-binary @img.json \
  | jq '{kind, recipe: .draft.recipe, unresolved: .draft.unresolved, fieldConfidence: .draft.fieldConfidence}'
```

(`base64 -i` is macOS; on Linux use `base64 -w0 "$f"`.)

**Expected:** the same shape from a handwritten card.

**Observed:** `draft` titled *apple cake*. `serves` and `minutes` are **null at
confidence 1** — the card states neither, and the model says so rather than inventing a
number. Eight lines; `almond essence` has a null quantity. Two resolved (`2 large eggs`
→ egg, `1 teaspoon Baking powder` → baking powder); six didn't, including `1 oz Flaked
almonds` and `8 oz selfraising flour` — a tree nut and gluten.

Both drafts now wait in `/review`. Neither is published: no confidence score publishes
anything.

## 7. The ghee story

One alias fixes a draft and changes what Cook does.

```bash
psql_() { docker compose exec -T postgres psql -U mise -d mise -Atc "$1"; }
DAL=$(psql_ "select id from recipe where title='Spiced lentil dal with ghee'")
CB=$(psql_ "select id from canonical_ingredient where name='clarified butter'")

# before: a draft is invisible to Cook
cook "Something with lentils" | jq '[.results[].recipe.title]'

curl -s -X POST "localhost:3000/api/review/$DAL/publish"                  # refused
curl -s localhost:3000/api/aliases -H 'content-type: application/json' \
  -d "{\"alias\":\"ghee\",\"canonicalId\":\"$CB\"}"                        # the fix
curl -s -X POST "localhost:3000/api/review/$DAL/publish"                  # accepted

cook "Something with lentils"           | jq '[.results[].recipe.title]'
cook "Something with lentils, no dairy" | jq '[.results[].recipe.title]'
cook "Something with lentils, no ghee"  | jq '{kind, titles: [.results[]?.recipe.title]}'
```

On screen, the same steps are in `/review`. The draft's Publish button is disabled with
the reason beside it, the unresolved line has a form to say what the term means, and
Publish is pressed by a person.

**Expected:** blocked → publish refused with its reason → alias added → line re-resolved
→ publish succeeds → the dal appears in an ordinary search and is gone from a dairy-free
one.

**Observed:**

| Step | Result |
|---|---|
| Search "Something with lentils", before | `ranked`; the dal is not among the five results: it is a draft |
| `/review` | each remaining draft's Publish button is `disabled` with its reason, e.g. *"Can't publish: 1 unresolved line — 100g panko. Mise won't call a recipe free of something it can't identify."* (checked in the page's HTML after the dal was published; the dal's own refusal is the 409 below) |
| Publish, before the alias | `409 {"error":"unresolved_ingredients","lines":[{"id":"…","rawText":"2 tbsp ghee"}]}` |
| `ghee` → `clarified butter` (→ `butter` → `dairy`) | `200 {"ok":true,"reresolved":1}` |
| Publish, after | `200 {"ok":true}`; status `published` |
| Search "Something with lentils" | **the dal is first** |
| Search "Something with lentils, no dairy" | **the dal is gone** |
| Step 3's "Something with lentils, no ghee" again | now `ranked`, not `needs_resolution`, and no dal |

A shortlist only shows the top five, so the dal's absence is also checked against the
tree, independently of ranking:

```sql
with recursive dairy as (
  select id from canonical_ingredient where name = 'dairy'
  union all
  select c.id from canonical_ingredient c join dairy d on c.parent_id = d.id
)
select r.title,
       not exists (select 1 from recipe_ingredient ri
                   where ri.recipe_id = r.id and ri.canonical_id in (select id from dairy)) as dairy_free
from recipe r where r.title = 'Spiced lentil dal with ghee';
```

```
          title             | dairy_free
----------------------------+------------
 Spiced lentil dal with ghee | f
```

Nobody marked the dal as containing dairy. It became dairy because `ghee` now points
into the dairy subtree — allergens hang off the ingredient, never the recipe.

## 8. Evals

Read [`evals/latest.md`](../evals/latest.md), the last committed run: which prompt
version and model produced each suite, and every metric against its threshold. The
exclusion metric's threshold is 1 and not negotiable.

**Observed:** `pass`. `extract-constraints` v5 on Haiku, 17 fixtures; `extract-recipe`
v2 on Sonnet, 6 fixtures.

`pnpm eval` re-runs it against the real API: (17 + 6) fixtures × 3 runs = **69 calls**,
costing real money and giving non-deterministic results. Don't run it to get through
this walkthrough.

---

## The recording

The 90-second recording is a subset of this walkthrough.

| Step | On camera | Why |
|---|---|---|
| 1 Clean start | no | Confidence check for the author; nothing to watch |
| 2 Cook | **yes** | The chips: the system showing what it understood, dairy as a safety constraint |
| 3 Gate 1 | **yes** | The model's answer is a question, not a guess |
| 4 Empty state | no | Correct, but not the argument |
| 5 Gate 3 | no | Usually nothing to see; the tests are the evidence |
| 6 Intake | **yes**, the photo | Handwriting in, a draft with honest nulls out |
| 7 Ghee story | **yes** | One alias: the draft publishes, and dairy-free search drops it |
| 8 Evals | briefly | The report exists and records which prompt produced it |
