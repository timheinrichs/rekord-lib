/**
 * A placeholder block. Give it the size of whatever it stands in for, so the
 * layout does not shift when the real content arrives.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-skeleton rounded-md bg-surface-2 ${className}`}
      aria-hidden="true"
    />
  );
}

/**
 * Placeholder rows for the track table. Rendered instead of the table, never
 * inside it: the virtualizer measures every non-spacer row in <tbody> by
 * position, so a foreign row there would shift every measurement.
 */
export function TrackTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading library" className="animate-fade-in">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex h-16 items-center gap-4 border-b border-border px-4 last:border-0"
        >
          <Skeleton className="h-4 w-4 shrink-0" />
          <Skeleton className="h-10 w-10 shrink-0 rounded" />
          <Skeleton className="h-4 min-w-0 flex-1" />
          <Skeleton className="h-4 w-32 shrink-0" />
          <Skeleton className="h-4 w-32 shrink-0" />
          <Skeleton className="h-4 w-24 shrink-0" />
          <Skeleton className="h-4 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Placeholder rows/cards for the Bandcamp collection. */
export function CollectionSkeleton({
  rows = 6,
  grid = false,
}: {
  rows?: number;
  grid?: boolean;
}) {
  if (grid) {
    return (
      <div
        role="status"
        aria-label="Loading collection"
        className="animate-fade-in grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4"
      >
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="aspect-square w-full rounded-lg" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-label="Loading collection"
      className="animate-fade-in flex flex-col"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-border py-3 last:border-0"
        >
          <Skeleton className="h-12 w-12 shrink-0 rounded" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-8 w-24 shrink-0" />
        </div>
      ))}
    </div>
  );
}
