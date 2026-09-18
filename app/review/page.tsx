import { connection } from "next/server";

import AliasFix, { type IngredientOption } from "../_components/alias-fix";
import Confidence from "../_components/confidence";
import DraftCard from "../_components/draft-card";
import PublishButton from "../_components/publish-button";
import { AlertIcon } from "../_components/ui/icons";
import { db } from "@/lib/db/client";
import { listDrafts, type QueuedDraft, type QueueLine } from "@/lib/db/drafts";
import { loadIngredientTree } from "@/lib/db/ingredients";
import { effectiveAllergenTags } from "@/lib/domain/ingredient-tree";

export default async function ReviewPage() {
  // Without this the build would prerender the queue from whatever database the build
  // machine can reach, and serve that snapshot as the queue from then on.
  await connection();
  const [drafts, tree] = await Promise.all([listDrafts(db), loadIngredientTree(db)]);
  const ingredients: IngredientOption[] = tree.nodes
    .map((node) => ({
      id: node.id,
      name: node.name,
      allergens: [...effectiveAllergenTags(tree.nodes, node.id)].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Review</h1>
          <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-muted tabular-nums">
            {drafts.length} in queue
          </span>
        </div>
        <p className="max-w-prose text-sm leading-relaxed text-muted">
          Every recipe still in draft, and no draft reaches a Cook result. Each
          ingredient line shows what was read beside what it resolved to. A line that
          resolved to nothing is a reason to keep its recipe here: Mise won&rsquo;t call a
          recipe free of something it can&rsquo;t identify.
        </p>
      </div>

      {drafts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border-strong px-4 py-10 text-center text-sm text-muted">
          Nothing in the queue.
        </p>
      ) : (
        drafts.map((draft) => <Draft key={draft.id} draft={draft} ingredients={ingredients} />)
      )}
    </section>
  );
}

function Draft({ draft, ingredients }: { draft: QueuedDraft; ingredients: IngredientOption[] }) {
  const unresolved = draft.lines.filter((line) => line.canonicalId === null).map((line) => line.rawText);
  const confidence = draft.fieldConfidence;

  return (
    <DraftCard>
      <div className="space-y-2 pr-24">
        <h2 className="text-lg font-semibold tracking-tight">{draft.title}</h2>
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span className="rounded-full bg-surface-muted px-2 py-0.5">serves {draft.serves ?? "not stated"}</span>
          <span className="rounded-full bg-surface-muted px-2 py-0.5">
            {draft.minutes === null ? "minutes not stated" : `${draft.minutes} min`}
          </span>
          <span className="rounded-full bg-surface-muted px-2 py-0.5">
            {draft.source === "seed" ? "from the seed" : "from Intake"}
          </span>
          {confidence && <Confidence score={confidence.title} of="Title" />}
        </p>
      </div>

      {/* The reason shown here is a preview. The route runs the same check again. */}
      <PublishButton recipeId={draft.id} unresolved={unresolved} hasLines={draft.lines.length > 0} />

      <div className="-mx-5 overflow-x-auto px-5">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-border-strong">
              <th className="py-2 pr-3 font-medium">Raw text</th>
              <th className="py-2 pr-3 font-medium">Resolved to</th>
              <th className="py-2 pr-3 font-medium">Qty</th>
              <th className="py-2 pr-3 font-medium">Unit</th>
              <th className="py-2 pr-3 font-medium">Optional</th>
              <th className="py-2 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((line, index) => (
              // Index included: a recipe can legitimately list the same line twice.
              <Line
                key={`${line.rawText}:${index}`}
                line={line}
                ingredients={ingredients}
                score={confidence?.ingredients.find((c) => c.rawText === line.rawText)?.confidence}
              />
            ))}
          </tbody>
        </table>
      </div>
    </DraftCard>
  );
}

function Line({
  line,
  ingredients,
  score,
}: {
  line: QueueLine;
  ingredients: IngredientOption[];
  score: number | undefined;
}) {
  const unresolved = line.canonicalId === null;
  return (
    <tr
      className={
        unresolved
          ? "border-b border-l-4 border-border border-l-danger bg-danger-soft"
          : "border-b border-border"
      }
    >
      {/* whitespace-pre-wrap: the raw text is shown as stored, leading spaces and all. */}
      <td className="py-2 pr-3 pl-2 font-mono text-xs whitespace-pre-wrap">{line.rawText}</td>
      <td className="py-2 pr-3">
        {unresolved ? (
          <>
            <strong className="inline-flex items-center gap-1 text-danger">
              <AlertIcon className="size-3.5" />
              unresolved
            </strong>
            <AliasFix term={line.name} ingredients={ingredients} />
          </>
        ) : (
          <span>{line.canonicalName}</span>
        )}
      </td>
      <td className="py-2 pr-3">{line.qty ?? "—"}</td>
      <td className="py-2 pr-3">{line.unit ?? "—"}</td>
      <td className="py-2 pr-3">{line.optional ? "yes" : "no"}</td>
      <td className="py-2">
        {score === undefined ? <span className="text-muted">—</span> : <Confidence score={score} of={line.rawText.trim()} />}
      </td>
    </tr>
  );
}
