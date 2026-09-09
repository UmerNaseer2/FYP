"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangleIcon } from "@/components/ui/icons";
import {
  ENVIRONMENTS,
  ENVIRONMENT_META,
  isProduction,
  type Environment,
} from "@/lib/environments";

/**
 * Client island on the schema-detail page: relabel this schema's environment.
 *
 * Tracking seeds the environment from the connection, but it has to be
 * changeable afterwards — a schema gets promoted, a server gets repurposed, and
 * every row that predates the column arrived as "unset". Without this the label
 * would be write-once, which is a label nobody would trust.
 *
 * Optimistic: the buttons move immediately, and only snap back if the PATCH
 * fails, because a four-button toggle that lags a round trip feels broken.
 *
 * The rest of the screen still has to catch up — the header pill and the
 * production warning read the same field. A screen that fetches its own data
 * passes `onDone` and reloads it; without one this falls back to
 * router.refresh(), which is what a server-rendered screen needs.
 */
export function SchemaEnvironmentPicker({
  trackedSchemaId,
  environment,
  onDone,
}: {
  trackedSchemaId: number;
  environment: Environment;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState<Environment>(environment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: Environment) {
    if (next === value || busy) return;
    const previous = value;
    setValue(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/lineage", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: trackedSchemaId, environment: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setValue(previous);
        setError(data?.error ?? "Could not change the environment.");
        return;
      }
      // Make the header pill and the production warning above agree with the
      // buttons.
      if (onDone) onDone();
      else router.refresh();
    } catch {
      setValue(previous);
      setError("Network error while changing the environment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="label">Environment</span>
        <span className="help">Drives the production warnings.</span>
      </div>
      <div className="seg" role="radiogroup" aria-label="Environment" style={{ display: "flex" }}>
        {ENVIRONMENTS.map((option) => (
          <button
            key={option}
            className={value === option ? "active" : ""}
            role="radio"
            aria-checked={value === option}
            onClick={() => void choose(option)}
            disabled={busy}
            type="button"
            style={{ flex: 1 }}
          >
            {ENVIRONMENT_META[option].label}
          </button>
        ))}
      </div>
      <p className="help mt-1.5">{ENVIRONMENT_META[value].help}</p>
      {isProduction(value) && (
        <p
          className="text-[12px] mt-1.5 inline-flex items-center gap-1.5"
          style={{ color: "var(--break)" }}
        >
          <AlertTriangleIcon size={12} />
          Compare, Drift and Deploy will call this out before they touch it.
        </p>
      )}
      {error && (
        <p className="text-[12px] mt-1.5" style={{ color: "var(--break)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
