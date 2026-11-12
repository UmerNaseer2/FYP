"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Pill, Skeleton } from "@/components/ui";
import { RefreshIcon } from "@/components/ui/icons";
import { apiFetch } from "@/lib/api-fetch";
import type { DriftStatus } from "@/lib/lineage-db";

export const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * What a phone says about an unreachable database, in place of the stored text.
 * That text can carry the connection's error, and with it the host.
 */
export const UNREACHABLE_TEXT = "The last check could not reach this database.";

const SIGNED_OUT_TEXT = "Your sign-in has ended. Sign out, then sign in again.";
export const OFFLINE_TEXT = "Could not reach the server. Check this device's connection and try again.";

/**
 * The server's own sentence when it is refusing someone, because those are
 * written for people. Anything else gets the fallback: an unexpected failure's
 * text could name a host, and hosts stay off the phone.
 */
export async function errorFrom(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return SIGNED_OUT_TEXT;
  if (![403, 404, 409, 412, 429].includes(response.status)) return fallback;
  const body = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

/**
 * Read one address, and again whenever the app comes back to the front. An
 * installed app stays in memory for days, so what it read this morning is not
 * what is true now.
 */
/** An open app hears nothing by itself, so every list can be asked again by hand. */
export function RefreshRow({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    await onRefresh();
    setBusy(false);
  }

  return (
    <div className="dv-refresh">
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
        <RefreshIcon className="ico" />
        Refresh
      </Button>
    </div>
  );
}

export function useJson<T>(path: string, fallback: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Only the newest read may answer, so a slow old one cannot write over it.
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const response = await apiFetch(path);
      if (mine !== latest.current) return;
      if (!response.ok) {
        const message = await errorFrom(response, fallback);
        if (mine === latest.current) setError(message);
        return;
      }
      const body = (await response.json()) as T;
      if (mine !== latest.current) return;
      setData(body);
      setError(null);
    } catch {
      if (mine === latest.current) setError(OFFLINE_TEXT);
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [path, fallback]);

  useEffect(() => {
    void reload();
    const onShow = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [reload]);

  return { data, error, loading, reload };
}

/** Sends something and reports what happened. Returns whether it worked. */
export async function sendJson(
  path: string,
  method: string,
  body: unknown,
  fallback: string,
  onError: (message: string) => void
): Promise<boolean> {
  try {
    const response = await apiFetch(path, {
      method,
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (response.ok) return true;
    onError(await errorFrom(response, fallback));
  } catch {
    onError(OFFLINE_TEXT);
  }
  return false;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="dv-err">
      {children}
    </div>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="dv-section">{children}</h2>;
}

export function Meta({ children }: { children: ReactNode }) {
  return <div className="dv-meta">{children}</div>;
}

export function RowsLoading() {
  return (
    <div className="dv-rows" role="status" aria-label="Loading">
      <Skeleton height={72} radius={18} />
      <Skeleton height={72} radius={18} />
      <Skeleton height={72} radius={18} />
    </div>
  );
}

export function DriftStatusPill({
  status,
  acknowledged,
}: {
  status: DriftStatus | null;
  acknowledged?: boolean;
}) {
  switch (status) {
    case "drifted":
      return <Pill tone="drift">{acknowledged ? "Drifted, acknowledged" : "Drifted"}</Pill>;
    case "unreachable":
      return <Pill tone="break">Unreachable</Pill>;
    case "in_sync":
      return <Pill tone="sync">In sync</Pill>;
    default:
      return <Pill tone="neutral">Not checked yet</Pill>;
  }
}
