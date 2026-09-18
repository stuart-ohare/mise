# API

Route handlers live here. They query Drizzle directly — there is no repository or
service layer until a second consumer appears (see `CLAUDE.md` §2).

Every request and response is parsed with the same Zod schema the model output uses.

## `POST /api/cook`

Where the three gates meet. `route.ts` is the HTTP shell; `run.ts` is the pipeline and
`schema.ts` holds both unions, which the Cook screen imports so the two ends parse the
same shape.

### Request

```ts
{ kind: "query";       query: string }             // extract constraints, then run
{ kind: "constraints"; constraints: Constraints }  // skip extraction — a corrected chip
```

The second shape exists so a misread exclusion can be fixed without retyping the
sentence. A client-supplied `exclude` is resolved by gate 1 and filtered by gate 2
exactly as an extracted one is: nothing here bypasses a gate, it only changes which
exclusions apply, which is the cook's call.

`400` is only for a body that is neither shape. A blank `query` is not a 400 — it is
`not_understood` / `empty_query`, because it is an outcome, not a malformed request.

### Response

One discriminated union, always `200`, so a client cannot handle the happy path and
forget the rest — an unhandled `kind` is a type error.

| `kind` | Means |
|---|---|
| `ranked` | Prose survived gate 3, and at least one row did. `attempts` is 1, or 2 when the retry was the clean one |
| `cards` | Safe rows, no prose. `reason` is `output_violation` (gate 3 rejected both attempts) or `ranking_unavailable` (call 3 failed, or named only ids gate 2 never returned) |
| `needs_resolution` | An exclusion mapped to nothing. No rows and no model call — it's a question for the cook |
| `no_candidates` | Nothing survived. `relaxTime` carries the stated limit and how many would match without it, when that is more than none |
| `not_understood` | Constraint extraction itself failed |

### What the route guarantees beyond the gates

Each gate is correct before this route exists. What it adds is the wiring, and three
parts of it fail closed:

- **An unresolved exclusion returns no rows**, and makes no gate 2 query and no model
  call. Returning rows filtered on only the resolved terms would silently answer a
  narrower question than the one asked.
- **Gate 3's terms are built from the resolved ids**, via `outputTerms`, so prose is
  held to the same widened set — ancestors and cross-tree tagged nodes — as the rows.
  Recipe ids are deliberately not scanned: call 3 has already replaced them with the
  candidate row's own spelling, and a uuid segment beginning `beef` would otherwise be
  a hit for a beef exclusion.
- **A `cards` response carries no generated text at all.** Gate 3's downgrade returns
  none, so there is nothing to render by mistake.

Call 3 failing is not treated as a gate event: the rows are still correct, so they
still go out as `cards`, and the retry isn't spent on an API error.

A ranking naming only ids gate 2 never returned is the same failure. Those ids are
dropped — a recipe gate 2 didn't approve cannot reach the screen however convincingly
the model names it — and if that leaves nothing, the answer is `cards` too, not a
`ranked` shortlist of no recipes. `ranked` carrying an empty `results` is rejected by
the response schema, so the one way to reach it is a pipeline regression, which is a
500 and a stack trace rather than a blank panel.

### `output_violation`

One row per matched term per attempt, because `matched_term` is singular — counting
which foods the prose reaches for is why the table exists. `query` holds the cook's
text, or the serialised constraints when the request was a chip edit. A rejected output
is a logged, counted event, never a swallowed one (§6).

### Time

`maxMinutes` eliminates rather than ranks, in the route rather than in gate 2's SQL:
the rows already carry `minutes`, so partitioning here costs no query and leaves gate 2
— whose SQL is pinned against `exclusionIds` by a parity test — untouched. A recipe with
no stated time counts as over the limit, because an unknown time is not a promise.

## `POST /api/intake`

The same trio as Cook: `route.ts` is the HTTP shell, `run.ts` is the pipeline, and
`schema.ts` holds both shapes, which the Intake screen imports so the two ends parse the
same thing. Text only — the image path is #73.

### Request

```ts
{ sourceKind: "text"; raw: string }
```

`sourceKind` is a literal rather than the `extraction_source` enum, so adding `image`
later is a compile error at every branch instead of a value that quietly falls through
the text one.

`400` is only for a body that isn't that shape. A blank `raw` is not a 400 — it is
`not_extracted` / `empty_input`, the rule `POST /api/cook` already set for a blank query,
and it never reaches the model.

### Response

| `kind` | Means |
|---|---|
| `draft` | Written and awaiting review. Carries `jobId`, `recipeId` and the draft, including `unresolved` — the raw text of every line that mapped to nothing |
| `not_extracted` | Call 2 failed (`empty_input`, `refused`, `parse_failed`, `api_error`). Nothing was written, so there is no job to show |

### What the route guarantees

- **The model never decides what an ingredient is.** Call 2 returns a name in the
  recipe's own words; `buildIntakeDraft` resolves it against the index built by
  `loadResolutionTerms` → `buildResolutionIndex`, the one gate 1 resolves exclusions
  against. A miss is `canonical_id = null`, never a near match.
- **Nothing published.** `status` is the literal `"draft"` in the domain type, in the
  response schema and in the row. `deriveRecipeStatus` — which publishes a recipe whose
  lines all resolved — is deliberately not used here: no score and no clean draft
  promotes itself (§2).
- **An extraction failure writes nothing.** A job row holding no recipe is work for a
  reviewer with nothing at the end of it.
- **Four tables or none.** The route opens the transaction and `writeIntakeDraft` runs
  inside it, so a job with no recipe, or a recipe with no audit trail, can't be left
  behind.
- **`raw_input` is the paste as it arrived**, untrimmed, even though call 2 was given the
  trimmed string. The job row is the record of what the user submitted.

## `POST /api/review/:id/publish`

The publish gate. `route.ts` is the HTTP shell. The rule is `publishDraft` in
`lib/db/publish.ts`. `schema.ts` holds the response union, which the review screen
imports so the two ends parse the same shape.

### Request

No body. The recipe id in the path is the whole input, so nothing a page rendered or
sends can change the answer. A request from the review screen and one from `curl` are
the same request.

### Response

| Status | Body | Means |
|---|---|---|
| `200` | `{ ok: true }` | Published. An Intake draft's `extraction_job` is now `promoted` |
| `409` | `{ error: "unresolved_ingredients", lines: [{ id, rawText }] }` | At least one line is at `canonical_id = null`. The recipe stays a draft |
| `409` | `{ error: "already_published" }` | The recipe isn't a draft |
| `404` | `{ error: "not_found" }` | No recipe has that id, including an id that isn't a uuid |

### What the route guarantees

- **An unresolved line blocks publication, optional lines included.** An unknown
  ingredient is exactly where an allergen hides, and a published recipe is a row gate 2
  can return. `unresolved_ingredients` names every blocking line by id and `raw_text`,
  so the refusal always carries its reason.
- **The check and the write are one statement.** One conditional `UPDATE` sets the
  status only where the recipe is still a draft and no line of it is unresolved. The
  reads after it only explain a refusal. They never decide one.
- **The recipe and its job move together.** The route opens the transaction, as Intake
  does, so a published recipe never points at a job still `awaiting_review`.
- **Only a person publishes.** No confidence score publishes anything, and no automated
  path calls this route: Intake writes drafts and stops (CLAUDE.md §2). The route has no
  auth, so anyone who can reach it can call it. That's safe because the rule above is
  the same whoever calls.
