"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A clock that re-renders its component on a timer.
 *
 * Relative ages ("checked 3m ago", "due in 8m") are read from Date.now() at
 * render time, so on a screen nobody clicks they quietly stop being true — a
 * page left open for an hour still says "checked 2m ago". This gives that page
 * a heartbeat.
 *
 * Built on useSyncExternalStore rather than useState + useEffect because the
 * wall clock IS an external store: React needs a snapshot that is stable within
 * a render pass, and a server-side snapshot that will not disagree with the
 * browser during hydration. Returns null on the server and for the hydrating
 * render; callers show a dash or an absolute timestamp for that one frame
 * instead of a relative age React would then have to correct.
 */
export function useNow(intervalMs = 30_000): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const timer = setInterval(onChange, intervalMs);
      return () => clearInterval(timer);
    },
    [intervalMs]
  );

  // Quantised to the tick. getSnapshot is called several times per render pass
  // and must return the same value each time, which a raw Date.now() cannot
  // promise — React would treat every call as a change and re-render forever.
  const getSnapshot = useCallback(
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    [intervalMs]
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
