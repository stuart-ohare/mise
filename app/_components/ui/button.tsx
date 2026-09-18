import type { ButtonHTMLAttributes } from "react";

import Spinner from "./spinner";

/**
 * The app's one button. `pending` is the waiting state every async action shows: a
 * spinner beside the caller's own label, the button disabled and marked busy. No state
 * of its own, so server and client trees can both render it.
 */

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover disabled:hover:bg-accent",
  secondary:
    "border border-border-strong bg-surface text-foreground shadow-sm hover:bg-surface-muted disabled:hover:bg-surface",
  ghost: "text-foreground hover:bg-surface-muted disabled:hover:bg-transparent",
};

const sizes: Record<Size, string> = {
  sm: "gap-1.5 rounded-md px-2.5 py-1 text-xs",
  md: "gap-2 rounded-lg px-4 py-2 text-sm",
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  pending?: boolean;
};

export default function Button({
  variant = "primary",
  size = "md",
  pending = false,
  disabled,
  className = "",
  children,
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={`inline-flex items-center justify-center font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {pending && <Spinner className={size === "sm" ? "size-3.5" : "size-4"} />}
      {children}
    </button>
  );
}
