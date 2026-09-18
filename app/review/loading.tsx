import { Skeleton } from "../_components/ui/skeleton";

/**
 * Shown while the queue query runs. The heading is real so the page is recognisably
 * Review at once; only the drafts, which need the database, are placeholders.
 */
export default function ReviewLoading() {
  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Review</h1>
        <Skeleton className="h-3 w-full max-w-prose" />
        <Skeleton className="h-3 w-2/3 max-w-prose" />
      </div>
      <p role="status" className="sr-only">
        Loading the review queue
      </p>
      {Array.from({ length: 2 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="space-y-4 rounded-xl border border-border bg-surface p-5 shadow-sm"
        >
          <Skeleton className="h-5 w-1/3" />
          <div className="flex gap-1.5">
            <Skeleton className="h-4 w-16 rounded-full" />
            <Skeleton className="h-4 w-14 rounded-full" />
            <Skeleton className="h-4 w-20 rounded-full" />
          </div>
          <Skeleton className="h-6 w-20" />
          {Array.from({ length: 4 }, (_, row) => (
            <div key={row} className="flex gap-4">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
              <Skeleton className="h-3 w-10" />
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
