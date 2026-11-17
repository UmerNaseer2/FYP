/**
 * Compact "3m ago" relative time, for a timestamp the server sent as ISO text.
 *
 * Deliberately client-only: it reads the browser clock, so calling it while
 * rendering on the server would produce a different string than the one the
 * browser then renders, and React would report a hydration mismatch. Every
 * caller is inside a "use client" component that renders after mount.
 */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
