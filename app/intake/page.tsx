import IntakeClient from "../_components/intake-client";

export default function IntakePage() {
  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Intake</h1>
        <p className="max-w-prose text-sm leading-relaxed text-muted">
          Paste a recipe blog&rsquo;s wall of text, or photograph a handwritten card. Out
          comes a structured draft with per-field confidence, which lands in the review
          queue — never straight into the database. An ingredient Mise can&rsquo;t name is
          left unresolved rather than guessed, and that keeps the recipe in draft,
          whichever way it came in.
        </p>
      </div>

      <IntakeClient />
    </section>
  );
}
