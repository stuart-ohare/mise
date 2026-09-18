"use client";

import Link from "next/link";
import { useState } from "react";

import { imageDataUriSchema, MAX_IMAGE_MB } from "@/lib/domain/image-input";

import { intakeResponseSchema, type IntakeRequest, type IntakeResponse } from "../api/intake/schema";
import Confidence from "./confidence";
import Button from "./ui/button";
import Callout from "./ui/callout";
import { AlertIcon } from "./ui/icons";
import LiveStatus from "./ui/live-status";
import { SkeletonDraft } from "./ui/skeleton";

/**
 * The Intake interaction. One POST per submit, no streaming: the response is parsed and
 * checked before anything renders (CLAUDE.md §2).
 *
 * What it draws is the audit trail, not a finished recipe. Every line shows the text the
 * model read beside what that resolved to, and a line that resolved to nothing is the
 * loudest thing on the screen — it is the one that keeps this recipe out of Cook.
 *
 * Two ways in, one request. A photograph is read to a data URI here and checked against
 * the same schema the route enforces, so an oversized card is a sentence on the screen
 * rather than a 400 the user has to interpret.
 */

const notExtracted: Record<Extract<IntakeResponse, { kind: "not_extracted" }>["reason"], string> = {
  empty_input: "There's nothing to read yet. Paste a recipe above.",
  refused: "Mise couldn't read that as a recipe.",
  parse_failed:
    "Mise couldn't get a whole recipe out of that — it needs an ingredient list and a method. Nothing was saved.",
  api_error: "Mise couldn't reach the model just now. Try again in a moment.",
};

export default function IntakeClient() {
  const [raw, setRaw] = useState("");
  const [card, setCard] = useState<{ name: string; dataUri: string } | null>(null);
  const [response, setResponse] = useState<IntakeResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(request: IntakeRequest): Promise<void> {
    setPending(true);
    setFailure(null);
    setResponse(null);

    try {
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });

      if (!res.ok) {
        setFailure(
          res.status === 400
            ? "Mise couldn't read that request. This is a bug, not something you did."
            : "Something broke on the way to the queue. Nothing was shown rather than something unchecked.",
        );
        return;
      }

      // Parsed with the schema the route validates against, so a pipeline change shows up
      // here as a caught failure rather than a half-rendered draft (§6).
      const parsed = intakeResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        setFailure("Mise got a draft it didn't recognise, so it isn't showing it.");
        return;
      }
      setResponse(parsed.data);
    } catch {
      setFailure("Couldn't reach Mise. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  async function chooseCard(file: File | null): Promise<void> {
    setFailure(null);
    setResponse(null);
    if (file === null) {
      setCard(null);
      return;
    }

    const dataUri = await readDataUri(file);
    // Checked here against the schema the route enforces, so the size and the format are
    // one rule with one wording, not a client guess that drifts from the boundary.
    const parsed = imageDataUriSchema.safeParse(dataUri);
    if (!parsed.success) {
      setCard(null);
      setFailure(
        `Mise can't read that file. It takes a JPEG, PNG, GIF or WebP of about ${MAX_IMAGE_MB} MB or less — ${file.name} is neither, or it's too big.`,
      );
      return;
    }

    setCard({ name: file.name, dataUri: parsed.data });
  }

  const readingCard = card !== null;

  return (
    <div className="space-y-8">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(
            card === null
              ? { sourceKind: "text", raw }
              : { sourceKind: "image", raw: card.dataUri },
          );
        }}
        className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm"
      >
        <div className="space-y-2">
          <label htmlFor="intake-raw" className="block text-sm font-medium">
            Paste the recipe
          </label>
          <textarea
            id="intake-raw"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            disabled={pending}
            rows={12}
            placeholder="Title, the story about someone's grandmother, the ingredient list, the method — paste the lot."
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs leading-relaxed placeholder:text-muted/70 focus:border-accent focus:ring-4 focus:ring-accent/15 focus:outline-none disabled:opacity-60"
          />
        </div>

        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>

        <div className="space-y-2">
          <label htmlFor="intake-card" className="block text-sm font-medium">
            Photograph a recipe card
          </label>
          <input
            id="intake-card"
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            disabled={pending}
            onChange={(event) => {
              void chooseCard(event.target.files?.[0] ?? null);
            }}
            className="block w-full text-xs text-muted file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground file:shadow-sm hover:file:bg-surface-muted disabled:opacity-60"
          />
          {card && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-muted p-2">
              {/* The card as the model will see it. next/image wants a known host or a
                  file on disk; this is neither, and a data URI needs no optimising. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={card.dataUri}
                alt={`The card to read: ${card.name}`}
                className="size-16 rounded-md border border-border object-cover"
              />
              <p className="text-xs text-muted">
                <span className="font-medium text-foreground">{card.name}</span> — this is
                read instead of the paste.{" "}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setCard(null)}
                  className="font-medium text-accent underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Use the paste instead
                </button>
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button type="submit" pending={pending}>
            {pending
              ? readingCard
                ? "Reading the card…"
                : "Reading…"
              : readingCard
                ? "Read the card"
                : "Extract a draft"}
          </Button>
        </div>
      </form>

      <LiveStatus
        message={
          pending
            ? "Reading the recipe"
            : response?.kind === "draft"
              ? "Draft ready"
              : ""
        }
      />

      {failure && <Callout tone="warning">{failure}</Callout>}

      {pending && <SkeletonDraft />}

      {response?.kind === "not_extracted" && (
        <Callout tone="warning">{notExtracted[response.reason]}</Callout>
      )}

      {response?.kind === "draft" && <Draft response={response} />}
    </div>
  );
}

/**
 * A File as the data URI the request carries. Resolves to "" on a read error, which the
 * schema then rejects with the same sentence an unreadable file gets — one failure
 * message rather than two.
 */
function readDataUri(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

function Draft({ response }: { response: Extract<IntakeResponse, { kind: "draft" }> }) {
  const { draft } = response;
  const { recipe, fieldConfidence } = draft;

  return (
    <section className="space-y-6">
      <div className="space-y-4 rounded-xl border border-border bg-surface p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold tracking-tight">{recipe.title}</h2>
          <Confidence score={fieldConfidence.title} of="Title" />
        </div>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <Scalar label="Serves" value={recipe.serves} score={fieldConfidence.serves} />
          <Scalar label="Minutes" value={recipe.minutes} score={fieldConfidence.minutes} />
        </dl>
      </div>

      {draft.unresolved.length > 0 && (
        <Callout tone="danger">
          <p className="font-semibold">
            {draft.unresolved.length === 1
              ? "1 ingredient didn't resolve."
              : `${draft.unresolved.length} ingredients didn't resolve.`}{" "}
            This recipe stays in draft.
          </p>
          <p className="text-muted">
            Mise won&rsquo;t claim a recipe is free of something it can&rsquo;t identify, so
            an unknown ingredient blocks publishing rather than being filed under a near
            match. Give it a name in{" "}
            <Link href="/review" className="font-medium text-accent underline-offset-2 hover:underline">
              Review
            </Link>{" "}
            to clear it.
          </p>
        </Callout>
      )}

      <div className="space-y-3 rounded-xl border border-border bg-surface p-5 shadow-sm">
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">
          Ingredients — what was read, and what it resolved to
        </h3>
        <ul className="divide-y divide-border">
          {draft.ingredients.map((line, index) => (
            // Index included: a recipe can legitimately list the same line twice.
            <li
              key={`${line.rawText}:${index}`}
              className={
                line.canonicalName === null
                  ? "-mx-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border-l-4 border-l-danger bg-danger-soft px-2 py-2 text-sm"
                  : "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-sm"
              }
            >
              <span className="font-mono text-xs">{line.rawText}</span>
              <span className="flex items-center gap-3">
                {line.canonicalName === null ? (
                  <span className="inline-flex items-center gap-1 font-semibold text-danger">
                    <AlertIcon className="size-3.5" />
                    unresolved
                  </span>
                ) : (
                  <span className="text-muted">→ {line.canonicalName}</span>
                )}
                <Confidence score={line.confidence} of={line.rawText.trim()} />
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-surface p-5 shadow-sm">
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Method</h3>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed marker:text-muted">
          {draft.steps.map((step) => (
            <li key={step.position}>{step.text}</li>
          ))}
        </ol>
      </div>

      <Callout>
        <p>
          Saved as a draft, awaiting review — nothing is published. It&rsquo;s in the{" "}
          <Link href="/review" className="font-medium text-accent underline-offset-2 hover:underline">
            review queue
          </Link>{" "}
          as job <code className="rounded bg-surface-muted px-1 font-mono text-xs">{response.jobId}</code>.
        </p>
      </Callout>
    </section>
  );
}

function Scalar({
  label,
  value,
  score,
}: {
  label: string;
  value: number | null;
  score: number;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex items-center gap-3">
        {/* The source said nothing, and nothing is what's shown. A plausible default here
            is the exact mistake the null rule exists to prevent. */}
        <span className="font-medium">
          {value === null ? <em className="font-normal text-muted">not stated</em> : value}
        </span>
        <Confidence score={score} of={label} />
      </dd>
    </div>
  );
}
