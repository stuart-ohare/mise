"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { publishResponseSchema } from "../api/review/[id]/publish/schema";
import { useCardBusy } from "./draft-card";
import Button from "./ui/button";
import Callout from "./ui/callout";

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
  // A transition, not a flag: it stays pending through the router.refresh() that follows,
  // so the button spins until the refreshed queue is on screen, not just until the POST
  // returns while the stale row is still showing.
  const [pending, startTransition] = useTransition();
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

  useCardBusy(pending);

  async function publish(): Promise<void> {
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
        startTransition(() => router.refresh());
      } else if (body.error === "unresolved_ingredients") {
        setRefused({ kind: "unresolved", lines: body.lines.map((line) => line.rawText) });
      } else if (body.error === "no_ingredients") {
        setRefused({ kind: "no_ingredients" });
      } else if (body.error === "already_published") {
        // Someone got there first. The queue is out of date, not wrong about safety.
        startTransition(() => router.refresh());
      } else {
        setFailure("This draft no longer exists.");
      }
    } catch {
      setFailure("Couldn't reach Mise. Nothing was published.");
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        pending={pending}
        disabled={blocked}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={() => startTransition(publish)}
      >
        {pending ? "Publishing…" : "Publish"}
      </Button>
      {blocker?.kind === "no_ingredients" && (
        <Callout tone="danger">
          <p id={reasonId} className="font-medium">
            Can&rsquo;t publish: this draft has no ingredient lines. Mise won&rsquo;t call a
            recipe free of anything until it knows what&rsquo;s in it.
          </p>
        </Callout>
      )}
      {blocker?.kind === "unresolved" && (
        <Callout tone="danger">
          <p id={reasonId} className="font-medium">
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
        </Callout>
      )}
      {failure && <Callout tone="warning">{failure}</Callout>}
    </div>
  );
}
