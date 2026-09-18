/**
 * An indeterminate ring. Hidden from assistive tech: whatever it sits beside says what is
 * happening, and the live region says it started. Under reduced motion it stops spinning
 * but stays drawn, so the wait is still visible.
 */
export default function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      className={`shrink-0 animate-spin motion-reduce:animate-none ${className}`}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
