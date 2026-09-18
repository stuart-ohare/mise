"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { publishResponseSchema } from "../api/review/[id]/publish/schema";

/**
 * The review screen's publish control. The rule is not here: `POST
 * /api/review/:id/publish` refuses a draft with no lines, or with an unresolved one,
 * however it is called.
 * This button only shows that refusal before the click, and it stays visible when
 * disabled, so a reviewer who can't publish can read why without opening a console.
 */

type Props = {
  recipeId: string;
  /** Raw text of each line at `canonical_id = null`, as the queue read them. */
  unresolved: string[];
  hasLines: boolean;
};

type Blocker = { kind: "unresolved"; lines: string[] } | { kind: "no_ingredients" };

export default function PublishButton({ recipeId, unresolved, hasLines }: Props) {
  const router = useRouter();
  const reasonId = useId();
  const [pending, setPending] = useState(false);
  // Set from the API's answer. It wins over the props, because the rows may have changed
  // since this page rendered.
  const [refused, setRefused] = useState<Blocker | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const fromProps: Blocker | null = !hasLines
    ? { kind: "no_ingredients" }
    : unresolved.length > 0
      ? { kind: "unresolved", lines: unresolved }
      : null;
  const blocker = refused ?? fromProps;
  const blocked = blocker !== null;

  async function publish(): Promise<void> {
    setPending(true);
    setFailure(null);
    try {
      const res = await fetch(`/api/review/${recipeId}/publish`, { method: "POST" });
      const parsed = publishResponseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) {
        setFailure("Publishing failed. Nothing was published.");
        return;
      }
      const body = parsed.data;
      if ("ok" in body) {
        router.refresh();
      } else if (body.error === "unresolved_ingredients") {
        setRefused({ kind: "unresolved", lines: body.lines.map((line) => line.rawText) });
      } else if (body.error === "no_ingredients") {
        setRefused({ kind: "no_ingredients" });
      } else if (body.error === "already_published") {
        // Someone got there first. The queue is out of date, not wrong about safety.
        router.refresh();
      } else {
        setFailure("This draft no longer exists.");
      }
    } catch {
      setFailure("Couldn't reach Mise. Nothing was published.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={blocked || pending}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={() => void publish()}
        className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Publishing…" : "Publish"}
      </button>
      {blocker?.kind === "no_ingredients" && (
        <p id={reasonId} className="text-sm font-medium">
          Can&rsquo;t publish: this draft has no ingredient lines. Mise won&rsquo;t call a
          recipe free of anything until it knows what&rsquo;s in it.
        </p>
      )}
      {blocker?.kind === "unresolved" && (
        <p id={reasonId} className="text-sm font-medium">
          Can&rsquo;t publish: {blocker.lines.length} unresolved{" "}
          {blocker.lines.length === 1 ? "line" : "lines"} —{" "}
          {blocker.lines.map((raw, index) => (
            <span key={`${raw}:${index}`}>
              {index > 0 && ", "}
              <q className="font-mono text-xs">{raw.trim()}</q>
            </span>
          ))}
          . Mise won&rsquo;t call a recipe free of something it can&rsquo;t identify.
        </p>
      )}
      {failure && <p className="text-sm">{failure}</p>}
    </div>
  );
}
