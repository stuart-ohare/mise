import type { ReactNode } from "react";

import { AlertIcon, BanIcon, InfoIcon } from "./icons";

/**
 * A notice that has to be read, not skimmed past. `danger` is for the things that keep a
 * recipe out of Cook or explain why a safety check held; `warning` for a degraded answer
 * that is still safe; `neutral` for everything else.
 */

type Tone = "neutral" | "warning" | "danger";

const tones: Record<Tone, { box: string; icon: ReactNode }> = {
  neutral: {
    box: "border-border bg-surface text-foreground",
    icon: <InfoIcon className="mt-0.5 size-4 text-muted" />,
  },
  warning: {
    box: "border-warning-border bg-warning-soft text-foreground",
    icon: <AlertIcon className="mt-0.5 size-4 text-warning" />,
  },
  danger: {
    box: "border-danger-border bg-danger-soft text-foreground",
    icon: <BanIcon className="mt-0.5 size-4 text-danger" />,
  },
};

export default function Callout({
  tone = "neutral",
  className = "",
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  const { box, icon } = tones[tone];
  return (
    <div className={`flex gap-3 rounded-xl border px-4 py-3 text-sm ${box} ${className}`}>
      {icon}
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}
