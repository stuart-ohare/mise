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
| `ranked` | Prose survived gate 3. `attempts` is 1, or 2 when the retry was the clean one |
| `cards` | Safe rows, no prose. `reason` is `output_violation` (gate 3 rejected both attempts) or `ranking_unavailable` (call 3 failed) |
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
