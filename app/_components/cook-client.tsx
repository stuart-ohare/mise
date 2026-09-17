"use client";

import Link from "next/link";
import { useRef, useState, type ReactElement, type ReactNode } from "react";

import {
  chipsFor,
  clearMaxMinutes,
  demoteExclusion,
  nextRequest,
  removeTerm,
  type Chip,
} from "@/lib/domain/constraint-edits";
import type { Constraints } from "@/lib/domain/constraints";
import type { CandidateRecipe } from "@/lib/db/candidates";

import { cookResponseSchema, type CookResponse } from "../api/cook/schema";
import { understoodFrom, type Understood } from "./understood";

/**
 * The whole Cook interaction, and the only client component in the app. One POST per
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
  const [pending, setPending] = useState(false);
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
    setPending(true);
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
      if (id === latest.current) setPending(false);
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
    <div className="space-y-6">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void post({ kind: "query", query }, null);
        }}
        className="space-y-3"
      >
        <label htmlFor="cook-query" className="block text-sm font-medium">
          What have you got?
        </label>
        <textarea
          id="cook-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          rows={3}
          placeholder="half a cauliflower, no dairy, 25 minutes, and I can't face another curry"
          className="w-full rounded border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/20"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {pending ? "Looking…" : "Find something"}
        </button>
      </form>

      {chips.length > 0 && <Chips chips={chips} onChip={onChip} />}

      {failure && (
        <p className="rounded border border-black/20 px-4 py-3 text-sm dark:border-white/20">
          {failure}
        </p>
      )}

      {response && (
        <Outcome
          response={response}
          onRelaxTime={() => understood && edit(clearMaxMinutes(understood.constraints))}
        />
      )}
    </div>
  );
}

function Chips({ chips, onChip }: { chips: Chip[]; onChip: (chip: Chip) => void }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium tracking-wide uppercase opacity-60">
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
                  ? "inline-flex items-center gap-2 rounded border-2 border-black px-2 py-1 text-sm font-semibold dark:border-white"
                  : "inline-flex items-center gap-2 rounded border border-black/20 px-2 py-1 text-sm opacity-80 dark:border-white/20"
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
                onClick={() => onChip(chip)}
                className={
                  chip.removable
                    ? "opacity-60 hover:opacity-100"
                    : "cursor-not-allowed opacity-30"
                }
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
      {chips.some((chip) => chip.hard) && (
        <p className="text-xs opacity-60">
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
      // `results` has no minimum: call 3 naming only ids the candidate set didn't
      // contain leaves every row dropped. Say so rather than render an empty list.
      return response.results.length === 0 ? (
        <Nothing>
          Mise filtered the recipes but couldn&rsquo;t put a shortlist together. Try
          again.
        </Nothing>
      ) : (
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
          <p className="rounded border border-black/20 px-4 py-3 text-sm opacity-80 dark:border-white/20">
            {cardsReason[response.reason]}
          </p>
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
        <div className="space-y-3 rounded border border-black/20 px-4 py-4 text-sm dark:border-white/20">
          <p>
            Mise doesn&rsquo;t know{" "}
            {response.unresolved.map((term, index) => (
              <span key={term}>
                {index > 0 && ", "}
                <em>{term}</em>
              </span>
            ))}
            , so it can&rsquo;t promise a recipe is free of it. No results, rather than
            results filtered on only the part it understood.
          </p>
          <p className="opacity-80">
            Edit the sentence above, or{" "}
            <Link href="/review" className="underline">
              add it in Review
            </Link>{" "}
            so Mise knows it next time.
          </p>
        </div>
      );

    case "no_candidates":
      return (
        <div className="space-y-3 rounded border border-black/20 px-4 py-4 text-sm dark:border-white/20">
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
              <p className="opacity-80">
                Nothing in {response.relaxTime.limit} minutes.{" "}
                {response.relaxTime.wouldMatch === 1
                  ? "1 match"
                  : `${response.relaxTime.wouldMatch} matches`}{" "}
                without a time limit.
              </p>
              <button
                type="button"
                onClick={onRelaxTime}
                className="rounded border border-black/30 px-3 py-1.5 text-sm font-medium dark:border-white/30"
              >
                Drop the time limit
              </button>
            </div>
          )}
        </div>
      );

    case "not_understood":
      return (
        <p className="rounded border border-black/20 px-4 py-3 text-sm dark:border-white/20">
          {notUnderstood[response.reason]}
        </p>
      );
  }
}

function Nothing({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-black/20 px-4 py-3 text-sm dark:border-white/20">
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
  const facts = [
    recipe.minutes === null ? null : `${recipe.minutes} min`,
    recipe.serves === null ? null : `serves ${recipe.serves}`,
  ].filter((fact): fact is string => fact !== null);

  return (
    <article className="space-y-2 rounded border border-black/10 px-4 py-4 dark:border-white/15">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-medium">{recipe.title}</h3>
        {facts.length > 0 && (
          <p className="shrink-0 text-xs opacity-60">{facts.join(" · ")}</p>
        )}
      </div>
      {recipe.summary && <p className="text-sm opacity-80">{recipe.summary}</p>}
      {rationale && <p className="text-sm">{rationale}</p>}
    </article>
  );
}
