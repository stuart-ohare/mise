import { connection } from "next/server";

import Confidence from "../_components/confidence";
import PublishButton from "../_components/publish-button";
import { db } from "@/lib/db/client";
import { listDrafts, type QueuedDraft, type QueueLine } from "@/lib/db/drafts";

export default async function ReviewPage() {
  // Without this the build would prerender the queue from whatever database the build
  // machine can reach, and serve that snapshot as the queue from then on.
  await connection();
  const drafts = await listDrafts(db);

  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Review</h1>
        <p className="max-w-prose text-sm opacity-80">
          Every recipe still in draft, and no draft reaches a Cook result. Each
          ingredient line shows what was read beside what it resolved to. A line that
          resolved to nothing is a reason to keep its recipe here: Mise won&rsquo;t call a
          recipe free of something it can&rsquo;t identify.
        </p>
      </div>

      {drafts.length === 0 ? (
        <p className="rounded border border-dashed border-black/20 px-4 py-6 text-sm opacity-70 dark:border-white/20">
          Nothing in the queue.
        </p>
      ) : (
        drafts.map((draft) => <Draft key={draft.id} draft={draft} />)
      )}
    </section>
  );
}

function Draft({ draft }: { draft: QueuedDraft }) {
  const unresolved = draft.lines.filter((line) => line.canonicalId === null).map((line) => line.rawText);
  const confidence = draft.fieldConfidence;

  return (
    <article className="space-y-3">
      <div className="space-y-1">
        <h2 className="font-medium">{draft.title}</h2>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-70">
          <span>serves {draft.serves ?? "not stated"}</span>
          <span>{draft.minutes === null ? "minutes not stated" : `${draft.minutes} min`}</span>
          <span>{draft.source === "seed" ? "from the seed" : "from Intake"}</span>
          {confidence && <Confidence score={confidence.title} of="Title" />}
        </p>
      </div>

      {/* The reason shown here is a preview. The route runs the same check again. */}
      <PublishButton recipeId={draft.id} unresolved={unresolved} />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="text-xs opacity-60">
            <tr className="border-b border-black/20 dark:border-white/25">
              <th className="py-1 pr-3 font-medium">Raw text</th>
              <th className="py-1 pr-3 font-medium">Resolved to</th>
              <th className="py-1 pr-3 font-medium">Qty</th>
              <th className="py-1 pr-3 font-medium">Unit</th>
              <th className="py-1 pr-3 font-medium">Optional</th>
              <th className="py-1 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((line, index) => (
              // Index included: a recipe can legitimately list the same line twice.
              <Line
                key={`${line.rawText}:${index}`}
                line={line}
                score={confidence?.ingredients.find((c) => c.rawText === line.rawText)?.confidence}
              />
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function Line({ line, score }: { line: QueueLine; score: number | undefined }) {
  const unresolved = line.canonicalId === null;
  return (
    <tr
      className={
        unresolved
          ? "border-b border-l-4 border-black/10 border-l-black dark:border-white/15 dark:border-l-white"
          : "border-b border-black/10 dark:border-white/15"
      }
    >
      {/* whitespace-pre-wrap: the raw text is shown as stored, leading spaces and all. */}
      <td className="py-1.5 pr-3 pl-2 font-mono text-xs whitespace-pre-wrap">{line.rawText}</td>
      <td className="py-1.5 pr-3">
        {unresolved ? <strong>unresolved</strong> : <span className="opacity-80">{line.canonicalName}</span>}
      </td>
      <td className="py-1.5 pr-3">{line.qty ?? "—"}</td>
      <td className="py-1.5 pr-3">{line.unit ?? "—"}</td>
      <td className="py-1.5 pr-3">{line.optional ? "yes" : "no"}</td>
      <td className="py-1.5">
        {score === undefined ? <span className="opacity-50">—</span> : <Confidence score={score} of={line.rawText.trim()} />}
      </td>
    </tr>
  );
}
