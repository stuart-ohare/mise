# Seed

The recipe catalogue is **synthetic**, generated once by a script here and committed as
JSON. No recipe site was scraped — that is a licensing problem this project does not
need, and a generated catalogue can be designed to contain the adversarial cases.

The canonical ingredient taxonomy — specifically the allergen hierarchy, its top two
levels — is **written by hand**, because a generated allergen tree is the one part of
this dataset a model shouldn't be trusted with. Generation fills the leaves, where
being wrong costs nothing.

Hand-authored where wrong answers matter, generated where they don't.

`pnpm seed` loads the committed JSON, so it works offline from a clean clone. It needs
only `DATABASE_URL` — no network, no API key — and is safe to rerun: a second run
changes nothing. Unset, it falls back to the local Docker database, as `drizzle.config.ts`
does, and prints the host and database it wrote to so a missed production URL is visible.

## The allergen tree — `taxonomy.json`

Six roots — `dairy`, `gluten`, `nuts`, `shellfish`, `egg`, `soy` — and their immediate
children, one node per line. Only a root carries its own tag; descendants inherit it, so
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
- **Shellfish includes molluscs** (mussels, clams, scallops, squid), not only crustaceans.
- **An ingredient with two allergens carries the second tag itself.** The tree is
  single-parent, so `soy sauce` and `miso` sit under `soy` and are tagged `gluten`: both
  are commonly made with wheat or barley, and rice-only miso is over-excluded on purpose.
  A child never repeats a tag it already inherits. Excluding an allergen therefore can't
  be a subtree walk alone: `exclusionIds` in `lib/domain/ingredient-tree.ts` also removes
  every node tagged with it, and gate 2's SQL has to match that function. The tag doesn't
  say which grain, so that widening applies to any exclusion inside the allergen's tree:
  "no wheat flour" removes soy sauce, and "no pasta" removes miso too.
- **Pasta and bread carry no extra tags,** though fresh pasta often has egg and bread can
  have milk. Tagging them would empty egg-free and dairy-free searches of every pasta and
  bread dish. Egg pasta belongs in the catalogue as its own leaf under `pasta`, tagged
  `egg` (#16).
- **Hand aliases include common plurals** (`eggs`, `prawns`). Gate 1 matches exactly, so
  a missing plural becomes a question to the user rather than a match.
- **An existing alias is never re-pointed.** If an alias in the database already points
  at a different ingredient — added during review, say — the seed aborts and rolls back.
- **Removing a node from the file doesn't delete it** from the database.

## Deliberately missing aliases

Some real ingredients are left unresolvable on purpose, so a fresh install starts with
recipes sitting in draft and a review queue that already has something in it. The alias
fix then has a real before-and-after.

| Term | The node it should resolve to | Why it's missing |
|---|---|---|
| `ghee` | `clarified butter` → `butter` → `dairy` | The review demo: add the alias, and the recipe vanishes from a dairy-free search |
| `panko` | `japanese breadcrumbs` → `breadcrumbs` → `gluten` | The same story for gluten |

The node exists; only the word doesn't. A test over the committed file fails if either
term is added as a name or alias. The third unresolved term, a regional ingredient name,
arrives with the recipe catalogue (#16).
