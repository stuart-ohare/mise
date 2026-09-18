"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import Spinner from "./ui/spinner";

/**
 * One draft in the Review queue. While any action inside it is in flight — publishing,
 * or an alias fix re-resolving its lines — the whole card dims, because every row in it
 * is about to be replaced by what the refresh brings back. The actions report in through
 * `useCardBusy`; the card's contents stay server-rendered.
 */

const BusyContext = createContext<Dispatch<SetStateAction<number>> | null>(null);

export function useCardBusy(busy: boolean): void {
  const report = useContext(BusyContext);
  useEffect(() => {
    if (!busy || report === null) return;
    report((count) => count + 1);
    return () => report((count) => count - 1);
  }, [busy, report]);
}

export default function DraftCard({ children }: { children: ReactNode }) {
  const [busy, setBusy] = useState(0);
  const pending = busy > 0;

  return (
    <BusyContext.Provider value={setBusy}>
      <article
        aria-busy={pending || undefined}
        className="relative rounded-xl border border-border bg-surface p-5 shadow-sm"
      >
        {pending && (
          <span className="absolute top-4 right-4 z-10 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium shadow-md">
            <Spinner className="size-3.5 text-accent" />
            Updating…
          </span>
        )}
        <div
          className={
            pending
              ? "space-y-4 opacity-50 transition-opacity duration-200"
              : "space-y-4 transition-opacity duration-200"
          }
        >
          {children}
        </div>
      </article>
    </BusyContext.Provider>
  );
}
