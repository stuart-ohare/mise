"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { aliasResponseSchema } from "../api/aliases/schema";

/**
 * The fix for an unresolved line: say what its term means, and every draft held by that
 * term re-resolves. The rules are in `POST /api/aliases`; this only asks the question.
 *
 * The term is the line's own and isn't editable. An alias changes what Cook does with
 * every exclusion naming it, so the form offers only the word a draft actually failed on.
 *
 * The picker shows the allergens the choice carries through the tree, because choosing
 * an ingredient here is choosing which exclusions the recipe will fall under — the
 * reviewer should see that before pressing the button, not find out from a Cook result.
 */

export type IngredientOption = { id: string; name: string; allergens: string[] };

type Props = {
  /** The term resolution missed on — the alias this form writes. */
  term: string;
  ingredients: IngredientOption[];
};

export default function AliasFix({ term, ingredients }: Props) {
  const router = useRouter();
  const listId = useId();
  const [choice, setChoice] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const picked = ingredients.find((option) => option.name === choice.trim());

  async function submit(): Promise<void> {
    if (!picked) {
      setMessage("Pick an ingredient from the list.");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/aliases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias: term, canonicalId: picked.id }),
      });
      const parsed = aliasResponseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) {
        setMessage("The alias wasn't saved.");
        return;
      }
      const body = parsed.data;
      if ("ok" in body) {
        router.refresh();
      } else if (body.error === "alias_exists") {
        setMessage(`“${term.trim()}” already means a different ingredient. Nothing was changed.`);
      } else if (body.error === "no_unresolved_line") {
        // Someone else's fix got there first; the queue on screen is out of date.
        router.refresh();
      } else {
        setMessage("That ingredient no longer exists. Nothing was changed.");
      }
    } catch {
      setMessage("Couldn't reach Mise. The alias wasn't saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="mt-1 flex flex-wrap items-center gap-1 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <q className="font-mono">{term.trim()}</q>
      <span aria-hidden>→</span>
      <input
        aria-label="Canonical ingredient"
        list={listId}
        value={choice}
        onChange={(event) => setChoice(event.target.value)}
        placeholder="ingredient"
        className="w-36 rounded border border-black/20 bg-transparent px-1 py-0.5 dark:border-white/25"
      />
      <datalist id={listId}>
        {ingredients.map((option) => (
          <option key={option.id} value={option.name} />
        ))}
      </datalist>
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-black/30 px-2 py-0.5 disabled:opacity-40 dark:border-white/30"
      >
        {pending ? "Saving…" : "Add alias"}
      </button>
      {picked && (
        <span className="basis-full opacity-70">
          {picked.allergens.length === 0 ? "carries no allergen tag" : `carries ${picked.allergens.join(", ")}`}
        </span>
      )}
      {message && <span className="basis-full">{message}</span>}
    </form>
  );
}
