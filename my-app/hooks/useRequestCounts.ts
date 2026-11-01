"use client";

import { useEffect, useState } from "react";
import { REQUESTS_CHANGED_EVENT } from "@/lib/access-requests";
import { apiFetch } from "@/lib/api-fetch";

/**
 * The number beside Requests in the rail: what is waiting on this person plus
 * the answers they have not read yet.
 *
 * The app sends no email and holds no connection open, so this is read when it
 * could have changed for someone working normally: on moving to another page,
 * on coming back to the window, and when the Requests page says it changed. A
 * failure reads as nothing waiting, because the rail is no place for an error.
 */
export function useRequestCounts(enabled: boolean, pathname: string | null): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    async function read() {
      let next = 0;
      try {
        const response = await apiFetch("/api/requests?only=counts");
        if (response.ok) {
          const counts = (await response.json())?.counts;
          next = (Number(counts?.waiting) || 0) + (Number(counts?.answered) || 0);
        }
      } catch {
        next = 0;
      }
      if (!stale) setCount(next);
    }
    void read();
    window.addEventListener("focus", read);
    window.addEventListener(REQUESTS_CHANGED_EVENT, read);
    return () => {
      stale = true;
      window.removeEventListener("focus", read);
      window.removeEventListener(REQUESTS_CHANGED_EVENT, read);
    };
  }, [enabled, pathname]);

  return enabled ? count : 0;
}
