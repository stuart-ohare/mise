# Seed

The recipe catalogue is **synthetic**, generated once by a script here and committed as
JSON. No recipe site was scraped — that is a licensing problem this project does not
need, and a generated catalogue can be designed to contain the adversarial cases.

The canonical ingredient taxonomy — specifically the allergen hierarchy, its top two
levels — is **written by hand**, because a generated allergen tree is the one part of
this dataset a model shouldn't be trusted with. Generation fills the leaves, where
being wrong costs nothing.

Hand-authored where wrong answers matter, generated where they don't.

Three ingredients are deliberately left out of the alias table, so a fresh install
starts with recipes sitting in draft and a review queue that already has something in
it. The alias fix then has a real before-and-after.

`pnpm seed` loads the committed JSON, so it works offline from a clean clone.
