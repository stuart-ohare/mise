/**
 * One extraction score, rendered. Review imports this rather than reinventing it, so the
 * two screens can't disagree about what a number means.
 *
 * The bands are deliberately coarse and the number is always shown beside them. A score
 * is the model's certainty about its own reading, not a probability the value is right,
 * and the one thing this must not do is look like a verdict — nothing here decides
 * anything, a human does.
 */

const bands = [
  { at: 0.85, label: "high" },
  { at: 0.6, label: "medium" },
  { at: 0, label: "low" },
] as const;

export function bandFor(score: number): string {
  return bands.find((band) => score >= band.at)?.label ?? "low";
}

export default function Confidence({ score, of }: { score: number; of: string }) {
  const band = bandFor(score);
  return (
    <span
      className={
        band === "low"
          ? "shrink-0 rounded border border-black/40 px-1.5 py-0.5 text-xs font-medium dark:border-white/40"
          : "shrink-0 text-xs opacity-60"
      }
      // The band alone would read as a grade; the number alone is hard to scan. Screen
      // readers get the field name too, since the bare score says nothing on its own.
      title={`${of}: ${band} confidence`}
    >
      <span className="sr-only">{of} confidence: </span>
      {band} {score.toFixed(2)}
    </span>
  );
}
