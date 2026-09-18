"use client";

import Link from "next/link";
import { useRef, useState, type ReactElement, type ReactNode } from "react";

import type { CandidateRecipe } from "@/lib/domain/candidate";
import {
  chipsFor,
  clearMaxMinutes,
  demoteExclusion,
  nextRequest,
  removeTerm,
  type Chip,
} from "@/lib/domain/constraint-edits";
import type { Constraints } from "@/lib/domain/constraints";

import { cookResponseSchema, type CookResponse } from "../api/cook/schema";
import { understoodFrom, type Understood } from "./understood";
import Button from "./ui/button";
import Callout from "./ui/callout";
import { ClockIcon, XIcon } from "./ui/icons";
import LiveStatus from "./ui/live-status";
import { SkeletonCards } from "./ui/skeleton";
import Spinner from "./ui/spinner";

/**
 * The whole Cook interaction. One POST per
 * submit, no streaming: the response is parsed and checked before anything renders,
 * which is the opposite of what streaming asks for (CLAUDE.md §2).
 *
 * The edits a chip makes live in lib/domain/constraint-edits.ts, tested offline. This
 * file renders them and nothing more — the ✕ that refuses is refusing because the pure
 * function refused, not because a component remembered to check.
 */

const notUnderstood: Record<
  Extract<CookResponse, { kind: "not_understood" }>["reason"],
  string
> = {
  empty_query: "There's nothing to go on yet. Say what you have and what you can't eat.",
  refused: "Mise couldn't read that as a request for something to cook.",
  parse_failed: "Mise couldn't make sense of that one. Try saying it a different way.",
  api_error: "Mise couldn't reach the model just now. Try again in a moment.",
};

const cardsReason: Record<Extract<CookResponse, { kind: "cards" }>["reason"], string> = {
  output_violation:
    "These rows are filtered and safe, but we couldn't write a safe summary for them, so we're not showing one.",
  ranking_unavailable: "Ranking is unavailable right now, so these are in no particular order.",
};

export default function CookClient() {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<CookResponse | null>(null);
  // Constraints and their unresolved terms are one value, never two. See ./understood.
  const [understood, setUnderstood] = useState<Understood | null>(null);
  // A fresh query replaces the results, so its wait is drawn as skeletons. An edit keeps
  // the results on screen but dims them: they were filtered on constraints the chips no
  // longer state, and must not read as the answer to the edit.
  const [pending, setPending] = useState<"query" | "edit" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Chip edits fire one POST each, and they can overtake one another. Only the newest
  // request may write state: a superseded response rendered beside corrected chips would
  // show a shortlist that was filtered on constraints the chips no longer state.
  const latest = useRef(0);
  // The last set the server actually accepted. A failed edit rolls back to it, so chips
  // never describe a correction the route rejected.
  const confirmed = useRef<Understood | null>(null);

  const chips = understood ? chipsFor(understood.constraints, understood.unresolved) : [];

  /**
   * Every failure branch. Shows no rows, and puts the chips back to the last set the
   * route accepted — an optimistic edit that survived a rejection would have the chips
   * claiming a correction the server never took.
   */
  function reject(message: string): void {
    setResponse(null);
    setUnderstood(confirmed.current);
    setFailure(message);
  }

  async function post(body: unknown, optimistic: Understood | null): Promise<void> {
    const id = ++latest.current;
    setPending(optimistic ? "edit" : "query");
    setFailure(null);
    if (optimistic) setUnderstood(optimistic);

    try {
      const res = await fetch("/api/cook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (id !== latest.current) return;

      if (!res.ok) {
        reject(
          res.status === 400
            ? "Mise couldn't read that request. This is a bug, not something you did."
            : "Something broke on the way to the kitchen. Nothing was shown rather than something unchecked.",
        );
        return;
      }

      // Parsed with the schema the route validates against, so a pipeline change shows
      // up here as a caught failure rather than a half-rendered screen (§6).
      const parsed = cookResponseSchema.safeParse(await res.json());
      if (id !== latest.current) return;

      if (!parsed.success) {
        reject("Mise got an answer it didn't recognise, so it isn't showing it.");
        return;
      }

      const next = understoodFrom(parsed.data);
      confirmed.current = next;
      setResponse(parsed.data);
      setUnderstood(next);
    } catch {
      if (id === latest.current) reject("Couldn't reach Mise. Check the connection and try again.");
    } finally {
      if (id === latest.current) setPending(null);
    }
  }

  function edit(next: Constraints): void {
    if (!understood || next === understood.constraints) return;

    // The unresolved terms travel with the constraints they belong to. An edit can't
    // resolve anything, so the list carries over untouched.
    void post(nextRequest(next), { constraints: next, unresolved: understood.unresolved });
  }

  function onChip(chip: Chip): void {
    if (!understood || !chip.removable) return;
    const { constraints, unresolved } = understood;

    edit(
      chip.field === "exclude"
        ? demoteExclusion(constraints, chip.term, unresolved)
        : chip.field === "maxMinutes"
          ? clearMaxMinutes(constraints)
          : removeTerm(constraints, chip.field, chip.term),
    );
  }

  return (
    <div className="space-y-8">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void post({ kind: "query", query }, null);
        }}
        className="rounded-2xl border border-border bg-surface p-2 shadow-sm transition-shadow focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15"
      >
        <label htmlFor="cook-query" className="block px-3 pt-2 text-sm font-medium">
          What have you got?
        </label>
        <textarea
          id="cook-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={pending === "query"}
          rows={3}
          placeholder="half a cauliflower, no dairy, 25 minutes, and I can't face another curry"
          className="block w-full resize-none bg-transparent px-3 py-2 text-base placeholder:text-muted/70 focus:outline-none disabled:opacity-60"
        />
        <div className="flex justify-end px-2 pb-1">
          <Button type="submit" pending={pending === "query"} disabled={pending !== null}>
            {pending === "query" ? "Finding recipes…" : "Find something"}
          </Button>
        </div>
      </form>

      <LiveStatus
        message={
          pending === "query"
            ? "Finding recipes"
            : pending === "edit"
              ? "Updating results"
              : response
                ? "Results updated"
                : ""
        }
      />

      {chips.length > 0 && <Chips chips={chips} onChip={onChip} />}

      {failure && <Callout tone="warning">{failure}</Callout>}

      {pending === "query" ? (
        <SkeletonCards />
      ) : (
        response && (
          <div
            aria-busy={pending === "edit" || undefined}
            className="relative"
          >
            {pending === "edit" && (
              <div className="absolute inset-x-0 -top-3 z-10 flex justify-center">
                <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium shadow-md">
                  <Spinner className="size-3.5 text-accent" />
                  Updating…
                </span>
              </div>
            )}
            <div
              className={
                pending === "edit"
                  ? "pointer-events-none opacity-40 blur-[1px] transition duration-200 select-none"
                  : "transition duration-200"
              }
            >
              <Outcome
                response={response}
                onRelaxTime={() => understood && edit(clearMaxMinutes(understood.constraints))}
              />
            </div>
          </div>
        )
      )}
    </div>
  );
}

function Chips({ chips, onChip }: { chips: Chip[]; onChip: (chip: Chip) => void }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">
        What Mise understood
      </h2>
      <ul className="flex flex-wrap gap-2">
        {chips.map((chip, index) => (
          // Index included: constraintsSchema doesn't dedupe, so the same term can
          // legitimately appear twice in one list.
          <li key={`${chip.field}:${chip.term}:${index}`}>
            <span
              className={
                chip.hard
                  ? "inline-flex items-center gap-1.5 rounded-full border border-danger-border bg-danger-soft py-1 pr-1.5 pl-3 text-sm font-semibold text-danger"
                  : "inline-flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pr-1.5 pl-3 text-sm text-foreground shadow-sm"
              }
            >
              {chip.label}
              <button
                type="button"
                // aria-disabled rather than disabled: the button stays focusable, so the
                // reason it refuses is reachable instead of being skipped over.
                aria-disabled={!chip.removable}
                aria-label={
                  chip.removable
                    ? chip.hard
                      ? `Stop excluding ${chip.term} — makes it a preference instead`
                      : `Remove ${chip.label}`
                    : `Mise doesn't know ${chip.term}, so it can't stop excluding it. Add it in Review first.`
                }
                title={
                  chip.removable
                    ? undefined
                    : `Mise doesn't know ${chip.term}, so it can't stop excluding it. Add it in Review first.`
                }
                onClick={() => onChip(chip)}
                className={
                  chip.removable
                    ? "grid size-5 place-items-center rounded-full opacity-60 transition hover:bg-black/10 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent dark:hover:bg-white/15"
                    : "grid size-5 cursor-not-allowed place-items-center rounded-full opacity-30"
                }
              >
                <XIcon className="size-3" />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {chips.some((chip) => chip.hard) && (
        <p className="text-xs text-muted">
          ✕ on a hard exclusion stops excluding it and keeps it as a preference, so the
          change is visible rather than silent. A second ✕ drops the preference too.
        </p>
      )}
    </section>
  );
}

function Outcome({
  response,
  onRelaxTime,
}: {
  response: CookResponse;
  onRelaxTime: () => void;
}): ReactElement {
  switch (response.kind) {
    case "ranked":
      // No empty case: `ranked` carries at least one row (schema.ts), and this only ever
      // renders what `cookResponseSchema` parsed. A server that sent an empty shortlist
      // would be refused by that parse and never reach here.
      return (
        <ul className="space-y-3">
          {response.results.map(({ recipe, rationale }) => (
            <li key={recipe.id}>
              <Card recipe={recipe} rationale={rationale} />
            </li>
          ))}
        </ul>
      );

    case "cards":
      return (
        <div className="space-y-3">
          <Callout tone="warning">{cardsReason[response.reason]}</Callout>
          {response.results.length === 0 ? (
            <Nothing>No recipes left to show.</Nothing>
          ) : (
            <ul className="space-y-3">
              {response.results.map((recipe) => (
                <li key={recipe.id}>
                  <Card recipe={recipe} rationale={null} />
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case "needs_resolution":
      return (
        <Callout tone="danger">
          <p>
            Mise doesn&rsquo;t know{" "}
            {response.unresolved.map((term, index) => (
              <span key={term}>
                {index > 0 && ", "}
                <em className="font-semibold">{term}</em>
              </span>
            ))}
            , so it can&rsquo;t promise a recipe is free of it. No results, rather than
            results filtered on only the part it understood.
          </p>
          <p className="text-muted">
            Edit the sentence above, or{" "}
            <Link href="/review" className="font-medium text-accent underline-offset-2 hover:underline">
              add it in Review
            </Link>{" "}
            so Mise knows it next time.
          </p>
        </Callout>
      );

    case "no_candidates":
      return (
        <Callout>
          <p>
            Nothing matches
            {response.constraints.exclude.length > 0 && (
              <>
                {" "}
                once {response.constraints.exclude.join(", ")}{" "}
                {response.constraints.exclude.length === 1 ? "is" : "are"} out
              </>
            )}
            .
          </p>
          {response.relaxTime && (
            <div className="space-y-3">
              <p className="text-muted">
                Nothing in {response.relaxTime.limit} minutes.{" "}
                {response.relaxTime.wouldMatch === 1
                  ? "1 match"
                  : `${response.relaxTime.wouldMatch} matches`}{" "}
                without a time limit.
              </p>
              <Button type="button" variant="secondary" size="sm" onClick={onRelaxTime}>
                Drop the time limit
              </Button>
            </div>
          )}
        </Callout>
      );

    case "not_understood":
      return <Callout tone="warning">{notUnderstood[response.reason]}</Callout>;
  }
}

function Nothing({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted">
      {children}
    </p>
  );
}

function Card({
  recipe,
  rationale,
}: {
  recipe: CandidateRecipe;
  rationale: string | null;
}) {
  return (
    <article className="space-y-2 rounded-xl border border-border bg-surface p-5 shadow-sm transition hover:border-border-strong hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <h3 className="font-semibold tracking-tight">{recipe.title}</h3>
        <div className="flex shrink-0 gap-1.5">
          {recipe.minutes !== null && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs text-muted">
              <ClockIcon className="size-3" />
              {recipe.minutes} min
            </span>
          )}
          {recipe.serves !== null && (
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-muted">
              serves {recipe.serves}
            </span>
          )}
        </div>
      </div>
      {recipe.summary && <p className="text-sm text-muted">{recipe.summary}</p>}
      {rationale && (
        <p className="border-l-2 border-accent/40 pl-3 text-sm leading-relaxed">{rationale}</p>
      )}
    </article>
  );
}
