# Seed

The recipe catalogue is **synthetic**, generated once by a script here and committed as
JSON. No recipe site was scraped — that is a licensing problem this project does not
need, and a generated catalogue can be designed to contain the adversarial cases.

The canonical ingredient taxonomy — specifically the allergen hierarchy above the
leaves — is **written by hand**, because a generated allergen tree is the one part of
this dataset a model shouldn't be trusted with. Generation fills the leaves, and a leaf
can never carry an allergen tag of its own — only inherit one from the hand-authored node
it hangs under.

Hand-authored where wrong answers matter, generated where they don't.

`pnpm seed` loads the committed JSON, so it works offline from a clean clone. It needs
only `DATABASE_URL` — no network, no API key — and is safe to rerun: a second run
changes nothing, and a run that would move an existing ingredient refuses (below).
Unset, it falls back to the local Docker database, as `drizzle.config.ts` does, and
prints the host and database it wrote to so a missed production URL is visible.

## The allergen tree — `taxonomy.json`

Six roots — `dairy`, `gluten`, `nuts`, `shellfish`, `egg`, `soy` — and the hand-authored
nodes under them, one node per line. Only a root carries its own tag; descendants inherit it, so
nobody tags `clarified butter` and it is still dairy.

Before anything is written, the file is parsed with its Zod schema and validated as a
whole (`lib/domain/taxonomy.ts`): every parent exists, there are no cycles, and names and
aliases are lowercase and unique across one shared namespace, and each allergen root
carries exactly its own tag while any other root carries none. A failure writes nothing.

Decisions worth knowing:

- **Peanut is under `nuts`.** Botanically it's a legume. But someone who says "no nuts"
  expects peanuts to be covered, and over-exclusion is the safe direction.
- **Oats are under `gluten`,** for the same reason: unless labelled gluten-free, oats are
  routinely contaminated with wheat.
- **Wheat is its own node under `gluten`,** with `wheat flour`, `bread`, `breadcrumbs`,
  `pasta` and `couscous` under it, so "no wheat" removes bread and pasta, not only flour.
  The tree is single-parent, and "made from wheat" is the one parent these share. `oats`,
  `barley`, `rye` and `worcestershire sauce` stay directly under `gluten`: "no wheat"
  doesn't remove them. `pasta` means wheat pasta; a rice or lentil pasta gets its own node
  outside `wheat`. This puts generated leaves up to four levels deep
  (`gluten → wheat → pasta → linguine`).
- **The alias `flour` belongs to `wheat`, not `wheat flour`.** Someone typing "no flour"
  usually means the allergy, and resolving it to one node would still offer bread and
  pasta. `plain flour` and `self-raising flour` stay on `wheat flour`. It over-excludes on
  purpose: a recipe line that just says "flour" resolves to `wheat`, so "no pasta" removes
  that recipe too, through the ancestor rule below.
- **Shellfish includes molluscs** (mussels, clams, scallops, squid), not only crustaceans.
- **An ingredient with two allergens carries the second tag itself.** The tree is
  single-parent, so `soy sauce` and `miso` sit under `soy` and are tagged `gluten`: both
  are commonly made with wheat or barley, and rice-only miso is over-excluded on purpose.
  A child never repeats a tag it already inherits. Excluding an allergen therefore can't
  be a subtree walk alone: `exclusionIds` in `lib/domain/ingredient-tree.ts` also removes
  every node tagged with it, and gate 2's SQL has to match that function. The tag doesn't
  say which grain, so that widening applies to any exclusion inside the allergen's tree:
  "no wheat flour" removes soy sauce, and "no pasta" removes miso too.
- **Excluding an ingredient also excludes its ancestors,** as single nodes. Recipe lines
  often resolve to a generic node (`eggs` is the `egg` root), and a generic ingredient may
  contain the specific one: "no egg white" removes a recipe that says "3 eggs", and "no
  peanuts" removes one that says "nuts". Their other children are unaffected.
- **Pasta and bread carry no extra tags,** though fresh pasta often has egg and bread can
  have milk. Tagging them would empty egg-free and dairy-free searches of every pasta and
  bread dish. `egg pasta` is its own hand-authored node under `pasta`, tagged `egg`, so an
  egg-free search can tell the two apart. It is hand-written rather than generated because
  generated leaves never carry a tag.
- **Hand aliases include common plurals** (`eggs`, `prawns`). Gate 1 matches exactly, so
  a missing plural becomes a question to the user rather than a match.
- **One term, one ingredient, across the database and the files.** Gate 1 resolves a
  term against names and aliases alike, so before writing anything the seed checks every
  name and alias already in the database together with the files
  (`lib/domain/term-namespace.ts`). If a term would belong to two ingredients (an alias
  that is already another ingredient's name, a node named after an existing alias, or
  an existing alias pointing somewhere other than the file says), it lists each
  collision with both ingredients, writes nothing and exits 1. Terms are compared the
  way gate 1 normalises them: Unicode NFC, lowercase, trimmed, runs of whitespace
  collapsed. So an existing alias is never re-pointed.
- **An existing ingredient's parent and tags are never overwritten unasked.** Moving a
  node, or changing its tags, moves every recipe under it into or out of an exclusion.
  Before writing, the seed compares each node already in the database with the files
  (`lib/domain/tree-changes.ts`: parents by name, tags as a set). If any differ, it lists
  them, writes nothing and exits 1:

  ```
  Nothing written: existing ingredients differ from the files.
    "pasta": parent "gluten" → "wheat"
  Re-run with --apply-tree-changes to apply them.
  ```

  A deliberate correction to the files, like #23 moving `pasta` and `bread` under
  `wheat`, reaches a database that's already seeded (production included) in two runs:
  `pnpm seed` to read the list, then `pnpm seed --apply-tree-changes` once every line is
  one you meant. The flag applies all of them, prints each, and never bypasses the term
  check above. A line you didn't expect means something else moved the node: find out
  what before applying.
- **Removing a node from the file doesn't delete it** from the database.

## Deliberately missing aliases

Some real ingredients are left unresolvable on purpose, so a fresh install starts with
recipes sitting in draft and a review queue that already has something in it. The alias
fix then has a real before-and-after.

| Term | The node it should resolve to | Why it's missing |
|---|---|---|
| `ghee` | `clarified butter` → `butter` → `dairy` | The review demo: add the alias, and the recipe vanishes from a dairy-free search |
| `panko` | `japanese breadcrumbs` → `breadcrumbs` → `gluten` | The same story for gluten |
| `brinjal` | `aubergine` (a generated leaf, no allergen) | The regional name: South Asian and South African English for aubergine. An unknown word holds a recipe in draft even when it hides no allergen |

The node exists; only the word doesn't. Tests over the committed files fail if any of the
three is added as a name or alias, or if any other ingredient in the catalogue fails to
resolve.

## The recipe catalogue — `recipes.json` and `leaves.json`

60 recipes and the leaf ingredients they use, generated once by `generate.ts` with
**`claude-sonnet-4-5`** and the `seed-catalogue` prompt at **`VERSION` 1**
(`lib/ai/prompts/seed-catalogue.ts`). Regenerating costs money and is never part of
`pnpm seed`:

```bash
pnpm tsx scripts/seed/generate.ts   # needs ANTHROPIC_API_KEY
pnpm vitest run scripts/seed/catalogue.test.ts
```

Each batch is parsed with the committed file schemas and validated against the whole
tree before it is kept; nothing is written unless all four pass. The files carry no
recipe status. `pnpm seed` resolves every ingredient's `name` exactly (case-insensitive)
against the names and aliases in the database, keeps `raw_text` always, and publishes a
recipe only if every ingredient — optional ones included — resolved. A recipe whose
title already exists is skipped, so re-seeding never undoes a promotion made in review.

The adversarial cases, each marked with `adversarialCase` for tests and reviewers:

- **Optional butter** — *Tomato and chickpea stew*. Its only dairy is a knob of butter
  in an optional finishing step, under a title that says nothing about dairy. It is
  published, so it's reachable by a dairy-free search: the gate 2 and gate 3 fixture.
- **Near-duplicate** — *Shrimp linguine with garlic and chilli* duplicates *Prawn
  linguine…*, naming the same ingredient by its alias `shrimp`.
- **Unresolved** — one recipe each for `ghee`, `panko` and `brinjal`, left in draft.

### Hand corrections after generation

The generated files were committed untouched first, so the commit after them is the
whole record of what review changed:

- **Five generated roots hid an allergen** and passed every schema check. They moved into
  `taxonomy.json` as hand-authored nodes: `oyster sauce` (shellfish, tagged gluten),
  `hoisin sauce` (soy, tagged gluten — the prompt forbade it, and it was generated
  anyway), `green curry paste` (shellfish: shrimp paste), `worcestershire sauce` (gluten:
  UK versions use barley malt vinegar) and `dark chocolate` (dairy, tagged soy: commonly
  milk fat or made on milk lines, with soy lecithin). `dark chocolate chips` now hangs
  under `dark chocolate`.
- **Considered and left alone:** stock, baking powder and curry powder, which some brands
  make with wheat. Over-excluding stock would empty most risottos and soups from a
  gluten-free search for a risk the recipe line doesn't carry.
- **Two recipes mentioned an allergen their ingredients don't carry.** *Garlic and chilli
  king prawns* ended "serve with crusty bread", and *Pistachio and lemon biscotti* was
  summarised as "almond biscuits". Gate 2 never reads prose, so both would pass an
  exclusion and then name the excluded food. Both lines were cut, and
  `catalogue.test.ts` now fails if a title, summary or step names a hand-authored
  ingredient, or anything under one, that the recipe doesn't carry.
- **The near-duplicate** had resolved `shrimp` to `prawn` itself; its `name` became
  `shrimp`, so the duplicate actually exercises the alias.
- **`cannelloni`, `linguine` and `penne` sit under `pasta` untagged,** following the
  taxonomy's decision for pasta: some dried tubes contain egg, and a recipe that means egg
  pasta names `egg pasta`.

A leaf whose name contains a hand-authored term (`smooth peanut butter`, `coconut milk`)
is the likeliest place for a second allergen to hide, so `catalogue.test.ts` fails until
each one is on a reviewed list with the reason it's safe.
