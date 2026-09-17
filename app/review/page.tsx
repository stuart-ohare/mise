export default function ReviewPage() {
  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Review</h1>
        <p className="max-w-prose text-sm opacity-80">
          The queue. Raw extracted text beside the resolved canonical ingredient,
          confidence per field, and a publish button that stays disabled — with the
          reason attached — while anything is unresolved.
        </p>
      </div>

      <p className="rounded border border-dashed border-black/20 px-4 py-6 text-sm opacity-70 dark:border-white/20">
        Not built yet. Deliberately plain when it is: back-office tooling that looks
        like back-office tooling reads as honest.
      </p>
    </section>
  );
}
