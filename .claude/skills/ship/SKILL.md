---
name: ship
description: Open the PR for a verified Mise issue branch with every acceptance criterion ticked against evidence. Final agent step of the loop; merging stays human. Use for "/ship" or "open the PR".
---

# /ship — verified branch → PR

## 1. Refuse unless verified

```bash
marker="$(git rev-parse --git-dir)/mise-verified"
[[ -z $(git status --porcelain) ]] && [[ -f $marker ]] && [[ $(cat "$marker") == $(git rev-parse HEAD) ]]
```

If this fails, `/verify` hasn't passed for this exact commit — run it. Don't write the
marker by hand.

## 2. Final checks

- `README.md` still describes what the code does (§4.4). Update it if not — then that's a
  new commit, so back to `/verify`.
- The branch contains only this issue's concern.

## 3. Push and open

```bash
git push -u origin HEAD
gh pr create --title "<issue title>" --body-file <body>
gh issue edit <n> --remove-label status:building --add-label status:in-review
```

Body follows `.github/pull_request_template.md`:

- `Closes #<n>` and a one-paragraph summary of why.
- **Acceptance criteria — with evidence**: every checkbox from the issue, ticked only
  with concrete evidence (output, test name, screenshot). An unticked box stays unticked
  with the reason — never tick on belief.
- **Invariant review**: the reviewer's verdict, and any CONCERNS with the user's decision.
- **Fixes found while verifying**, **Known gaps**, **Invariant / gates touched**.
- End with the session's PR attribution line.

## 4. Hand over

Give the user the PR URL. Merging is always the human's call — never run `gh pr merge`.
