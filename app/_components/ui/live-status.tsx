/**
 * The spoken half of a waiting state. Spinners and skeletons are hidden from assistive
 * tech, so this is where a screen reader hears that something started and that it ended.
 * The region is always mounted — a live region that appears with its message is often
 * not announced at all.
 */
export default function LiveStatus({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}
