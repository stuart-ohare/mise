export default function CookPage() {
  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Cook</h1>
        <p className="max-w-prose text-sm opacity-80">
          Say what you have and what you can&rsquo;t eat, in your own words. Mise shows
          you what it understood before it shows you recipes — hard exclusions are
          treated as a safety property, not a ranking signal.
        </p>
      </div>

      <p className="rounded border border-dashed border-black/20 px-4 py-6 text-sm opacity-70 dark:border-white/20">
        Not built yet. Tracked in the issues board: constraint extraction, the SQL
        exclusion filter, then this screen.
      </p>
    </section>
  );
}
