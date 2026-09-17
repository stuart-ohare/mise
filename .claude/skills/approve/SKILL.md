---
name: approve
description: Approve the plan on a Mise issue by moving status:spec to status:planned, behind a permission prompt the human answers. User-only; the model can't invoke it. Use for "/approve <n>".
disable-model-invocation: true
---

# /approve <n> — the human approves a plan

`status:planned` is the human's plan approval (ADR 0003). The user typing `/approve`
and then accepting the permission prompt is that approval. Nothing else counts.

## 1. Preconditions

```bash
gh issue view <n> --json state,labels,comments --jq '{
  state,
  labels: [.labels[].name],
  plans: [.comments[] | select(.body | test("^\\s*## Plan( amendment)?[ \\t\\r]*(\\n|$)")) |
          {url, amendment: (.body | test("^\\s*## Plan amendment"))}]
}'
```

Refuse and stop, naming the reason, unless **all** of these hold:

- `state` is `OPEN`. Otherwise: "#<n> is closed."
- `labels` contains `status:spec`. Otherwise name the `status:*` label it has. For
  example, "#<n> is `status:planned` already" or "#<n> is `status:building`, so its
  plan was approved earlier."
- `plans` has at least one entry that isn't an amendment. Otherwise: "#<n> has no
  `## Plan` comment. Run `/plan <n>` first."

## 2. Show what's being approved

Before moving the label, write out the full comment URLs from the `url` field, one per
line, in this shape. Never summarise them as "a single plan" or leave them out:

```
Plan:      https://github.com/<owner>/<repo>/issues/<n>#issuecomment-…
Amendment: https://github.com/<owner>/<repo>/issues/<n>#issuecomment-…
```

`Plan` is the **latest** non-amendment `## Plan` comment. There's one `Amendment` line
for each `## Plan amendment`, oldest first, or none. Then say: accepting the next prompt
approves these.

## 3. Move the label

One call, exactly:

```bash
gh issue edit <n> --remove-label status:spec --add-label status:planned
```

The Bash guard asks the human before running it. Don't post an approval comment. The
label event on the issue is the record.

- **Accepted:** confirm with `gh issue view <n> --json labels`, and tell the user the
  next step is `/build <n>`.
- **Declined:** the plan stays unapproved. Say so and stop. Don't retry, and don't try
  another route to the label.
