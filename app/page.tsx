import CookClient from "./_components/cook-client";

export default function CookPage() {
  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Cook</h1>
        <p className="max-w-prose text-sm leading-relaxed text-muted">
          Say what you have and what you can&rsquo;t eat, in your own words. Mise shows
          you what it understood before it shows you recipes — hard exclusions are
          treated as a safety property, not a ranking signal.
        </p>
      </div>

      <CookClient />
    </section>
  );
}
