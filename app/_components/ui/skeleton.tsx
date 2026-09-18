/**
 * Placeholders shaped like what is about to land. They stand in for content, so they are
 * hidden from assistive tech; the live region carries the announcement instead.
 */

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-md bg-surface-muted motion-reduce:animate-none ${className}`}
    />
  );
}

export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <ul aria-hidden className="space-y-3">
      {Array.from({ length: count }, (_, index) => (
        <li
          key={index}
          className="space-y-3 rounded-xl border border-border bg-surface p-5 shadow-sm"
        >
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </li>
      ))}
    </ul>
  );
}

export function SkeletonDraft() {
  return (
    <div aria-hidden className="space-y-6">
      <div className="space-y-4 rounded-xl border border-border bg-surface p-5 shadow-sm">
        <Skeleton className="h-5 w-1/2" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-surface p-5 shadow-sm">
        <Skeleton className="h-3 w-40" />
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-center justify-between gap-4">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-surface p-5 shadow-sm">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    </div>
  );
}
